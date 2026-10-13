"""Repository-owned harness calling the real pinned Hermes discovery and dispatch path.

Only user approval responses and the localhost model are controlled fixtures. MCP
transport, registry handlers, discovery annotations, and host trust enforcement are real.
"""
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import threading
import subprocess
import signal
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

inputs = json.loads(Path(sys.argv[1]).read_text())
assert Path(sys.executable).resolve() == Path(inputs["python"]).resolve(), "Wrong managed interpreter"
from hermes_cli.agent_plugins import load_agent_plugin
from tools.mcp_tool_discovery import register_mcp_servers
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.mcp_tool_handlers import _tool_is_read_only
from tools.registry import registry

home = Path(os.environ["HERMES_HOME"])
config = json.loads((home / "config.yaml").read_text())
names = register_mcp_servers(config["mcp_servers"])
read_name = next(name for name in names if name.endswith("smoke_read"))
write_name = next(name for name in names if name.endswith("smoke_write"))
assert _tool_is_read_only("openfunctions", "smoke_read")
assert not _tool_is_read_only("openfunctions", "smoke_write")

model_requests = []
model_action = {"name": read_name, "arguments": {}}
class LocalModel(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path != "/v1/chat/completions":
            self.send_error(404, "Unsupported local fixture endpoint")
            return
        model_requests.append(payload)
        calls = [message for message in payload["messages"] if message["role"] == "tool"]
        message = {"role": "assistant", "content": "HERMES_LOCAL_PROOF_DONE"}
        reason = "stop"
        if not calls:
            available = [tool["function"]["name"] for tool in payload.get("tools", [])]
            # The pin exposes deferred tools through its normal tool_call bridge.
            requested, supplied = model_action["name"], model_action["arguments"]
            target, arguments = (requested, supplied) if requested in available else ("tool_call", {"calls": [{"name": requested, "arguments": supplied}]})
            assert target in available, available
            message = {"role": "assistant", "content": None, "tool_calls": [{"id": "local_read_1", "type": "function", "function": {"name": target, "arguments": json.dumps(arguments)}}]}
            reason = "tool_calls"
        response = {"id": "local-proof", "object": "chat.completion", "created": 1, "model": "local-proof", "choices": [{"index": 0, "message": message, "finish_reason": reason}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        if payload.get("stream"):
            delta = dict(message)
            for index, call in enumerate(delta.get("tool_calls", [])):
                call["index"] = index
            response["object"] = "chat.completion.chunk"
            response["choices"] = [{"index": 0, "delta": delta, "finish_reason": reason}]
            body = ("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode()
            kind = "text/event-stream"
        else:
            body = json.dumps(response).encode()
            kind = "application/json"
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

local_model = ThreadingHTTPServer(("127.0.0.1", 0), LocalModel)
threading.Thread(target=local_model.serve_forever, daemon=True).start()

def decode_host_result(raw):
    payload = json.loads(raw) if isinstance(raw, str) else raw
    if isinstance(payload, dict) and isinstance(payload.get("result"), str):
        return json.loads(payload["result"])
    return payload

def model_tool(name, arguments, allow_error=False):
    from run_agent import AIAgent
    model_action.update(name=name, arguments=arguments)
    outputs = []
    agent = AIAgent(base_url=f"http://127.0.0.1:{local_model.server_port}/v1", api_key="local-fixture-only", provider="custom", api_mode="chat_completions", model="local-proof", enabled_toolsets=["mcp-openfunctions"], max_iterations=3, quiet_mode=True, skip_context_files=True, skip_memory=True, skip_background_review=True, save_trajectories=False, cwd=str(home), tool_complete_callback=lambda _id, _name, _args, result: outputs.append(result))
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="accept"):
        turn = agent.run_conversation(f"Call the configured tool {name} with these exact fixture arguments: {json.dumps(arguments)}.", system_message="Use the selected configured tool once. Report its returned result.")
    assert turn["final_response"] == "HERMES_LOCAL_PROOF_DONE", turn
    assert outputs, turn
    result = decode_host_result(outputs[-1])
    if not allow_error:
        assert "error" not in result, result
    return result

def cli(*args, input_text=None):
    call = subprocess.run([inputs["binary"], *args], input=input_text, text=True, capture_output=True, check=True)
    log = Path(inputs["scratch"]) / "work-cli.jsonl"
    with log.open("a") as stream:
        stream.write(json.dumps({"argv": list(args), "stdout": call.stdout, "stderr": call.stderr}) + "\n")
    return call.stdout

def authorize_job(config_path, work_item):
    preview = Path(inputs["scratch"]) / f"preview-{work_item}.json"
    cli("work", "prepare", "--config", str(config_path), "--work-item", work_item, "--out", str(preview))
    cli("work", "authorize", "--config", str(config_path), "--preview", str(preview), input_text="AUTHORIZE\nCOMPLETE\n")
    grants = json.loads(cli("work", "grants", "list", "--config", str(config_path)))
    matching = [grant for grant in grants if grant["workItemId"] == work_item]
    assert len(matching) == 2 and any(grant["completion"] for grant in matching), matching
    return matching

def kill_work_process(workspace):
    import psutil
    identity = json.loads((workspace / "work-server-process.json").read_text())
    process = psutil.Process(identity["pid"])
    assert os.getpid() in [parent.pid for parent in process.parents()], "Fixture PID is not owned by this isolated Hermes process"
    assert abs(process.create_time() * 1000 - identity["startedAt"]) < 3000, "Fixture PID was recycled"
    process.kill()
    return identity

def work_proof(servers):
    shutdown_mcp_servers()
    data_root = Path(servers["openfunctions"]["cwd"])
    workspace = Path(inputs["scratch"]) / "work-subject"
    workspace.mkdir(mode=0o700)
    fixture = workspace / "fixture.json"
    fixture.write_text(json.dumps({"status": "needs_correction", "value": 0}))
    verifier = workspace / "verify.mjs"
    verifier.write_text("import {readFileSync} from 'node:fs'; const x=JSON.parse(readFileSync(process.argv[2],'utf8')); console.log(JSON.stringify(x)); process.exit(x.status==='corrected'&&x.value===1?0:1);")
    catalog = Path(inputs["fixture"]).parent / "trusted-work.mjs"
    catalog.write_text("import {createLocalFixtureBindings} from 'openfunction/framework/work'; import {existsSync,writeFileSync} from 'node:fs'; import {basename,join} from 'node:path';\nexport function createWorkBindings({workspaceRoot}) {const bindings=createLocalFixtureBindings({workspaceRoot,fixturePath:'fixture.json',verifierPath:'verify.mjs',afterEffect:async()=>{writeFileSync(join(workspaceRoot,'work-server-process.json'),JSON.stringify({pid:process.pid,startedAt:Date.now()-process.uptime()*1000}),{mode:0o600});if(existsSync(join(workspaceRoot,'park-after-effect'))){writeFileSync(join(workspaceRoot,'effect-ready'),'ready');await new Promise(()=>{});}else{await new Promise(resolve=>setTimeout(resolve,3500));}}});if(basename(workspaceRoot)==='uncertain-subject'){delete bindings.steps.correct.prepareReconciliation;delete bindings.steps.correct.reconcileEffect;delete bindings.steps.correct.reconciliationSpecDigest;}return bindings;}\n")
    config_path = data_root / "config.json"
    generator = Path(inputs["fixture"]).parent / "prepare-work.mjs"
    generator.write_text("import {writeFileSync} from 'node:fs'; import {createWorkBindings} from './trusted-work.mjs';\n" +
        "const [workspaceRoot,dataDir,grantDir,modulePath,configPath]=process.argv.slice(2);\n" +
        "const b=createWorkBindings({workspaceRoot}); const workItems=['correction','stale','revocation','uncertain','oracle'].map(workItemId=>({workItemId,contract:b.contract,plan:{id:'fixture-plan-'+workItemId,version:1,state:'active',steps:[b.verificationStep]}}));\n" +
        "writeFileSync(configPath,JSON.stringify({schemaVersion:1,workspaceRoot,dataDir,grantDir,backend:{kind:'local',backendId:'hermes-local-proof',workspaceId:'profile-a',workItems},stepCatalog:{kind:'module',modulePath},leaseSeconds:2,limits:{maxAttempts:1,maxDurationMs:60000,maxActions:20,maxOutputBytes:1048576}}),{mode:0o600});\n")
    subprocess.run(["node", str(generator), str(workspace), str(data_root / "runtime"), str(data_root / "grants"), str(catalog), str(config_path)], cwd=catalog.parent, check=True)
    config_path.chmod(0o600)
    # Drop the earlier ordinary smoke override; use the actual portable MCP declaration.
    from hermes_cli.config import load_config, save_config
    native = load_config()
    native["mcp_servers"] = {}
    save_config(native)
    names = register_mcp_servers(servers)
    prefix = "mcp__openfunctions__"
    assert set(names) == {prefix + name for name in ["of_work_prepare", "of_work_start", "of_work_step", "of_work_verify", "of_work_status", "of_work_reconcile", "of_work_finish", "of_work_artifact_read"]}, names
    preview = model_tool(prefix + "of_work_prepare", {"workItemId": "correction"})
    assert preview["binding"]["workItemId"] == "correction"
    grants = authorize_job(config_path, "correction")
    started = model_tool(prefix + "of_work_start", {"workItemId": "correction"})
    assert started["state"] == "running", started
    inspected = model_tool(prefix + "of_work_step", {"stepKey": "inspect", "params": {}})
    digest = inspected["result"]["data"]["expectedDigest"]
    before = time.monotonic()
    # Interrupt success delivery after the real RPC and controller journal commit,
    # before Hermes receives the successful model-facing tool result.
    from tools import mcp_tool_handlers as handlers
    original_render = handlers._render_call_tool_result
    lost_results = []
    killed_processes = []
    def lose_success(result, server_name, image_paths=None):
        raw = original_render(result, server_name, image_paths)
        decoded = decode_host_result(raw)
        if server_name == "openfunctions" and decoded.get("receipt", {}).get("toolName") == "fixture_correct":
            lost_results.append(decoded)
            killed_processes.append(kill_work_process(workspace))
            raise RuntimeError("Fixture interrupted successful result before model delivery")
        return raw
    with patch.object(handlers, "_render_call_tool_result", side_effect=lose_success):
        lost_delivery = model_tool(prefix + "of_work_step", {"stepKey": "correct", "params": {"expectedDigest": digest}}, allow_error=True)
    assert "error" in lost_delivery, lost_delivery
    assert len(lost_results) == 1, lost_results
    corrected = lost_results[0]
    assert corrected["outcome"] == "succeeded", corrected
    assert time.monotonic() - before >= 3.5
    assert json.loads(fixture.read_text())["value"] == 1
    backend_lines = list((data_root / "runtime" / "backend").glob("*.jsonl"))
    assert any('"kind":"heartbeat"' in path.read_text() for path in backend_lines), "Long step did not renew lease"
    # A real process interruption after a recorded result preserves the subject and receipts.
    prior_mtime = fixture.stat().st_mtime_ns
    killed = killed_processes[0]
    shutdown_mcp_servers()
    register_mcp_servers(servers)
    recovered = model_tool(prefix + "of_work_reconcile", {})
    assert recovered["state"] == "running", recovered
    assert recovered["lastStepExecution"]["result"]["data"]["corrected"] is True, recovered
    assert recovered["lastStepExecution"]["executionId"] == corrected["receipt"]["executionId"], recovered
    assert fixture.stat().st_mtime_ns == prior_mtime, "Recovery repeated a known write"
    verified = model_tool(prefix + "of_work_verify", {"stepId": "fixture-check"})
    assert verified["outcome"] == "passed", verified
    finished = model_tool(prefix + "of_work_finish", {})
    assert finished["state"] == "completed", finished
    completed_config = data_root / "completed-config.json"
    completed_config.write_bytes(config_path.read_bytes())
    completed_config.chmod(0o600)

    def activate_case(case, initial=None):
        shutdown_mcp_servers()
        target = Path(inputs["scratch"]) / (case + "-subject")
        target.mkdir(mode=0o700)
        subject_file = target / "fixture.json"
        subject_file.write_text(json.dumps(initial or {"status": "corrected", "value": 1}))
        (target / "verify.mjs").write_bytes(verifier.read_bytes())
        subprocess.run(["node", str(generator), str(target), str(data_root / (case + "-runtime")), str(data_root / (case + "-grants")), str(catalog), str(config_path)], cwd=catalog.parent, check=True)
        config_path.chmod(0o600)
        case_grants = authorize_job(config_path, case)
        register_mcp_servers(servers)
        model_tool(prefix + "of_work_start", {"workItemId": case})
        return target, subject_file, case_grants

    _, stale_fixture, _ = activate_case("stale")
    stale_verified = model_tool(prefix + "of_work_verify", {"stepId": "fixture-check"})
    assert stale_verified["outcome"] == "passed", stale_verified
    subject = json.loads(stale_fixture.read_text())
    subject["interference"] = "changed after passing verification"
    stale_fixture.write_text(json.dumps(subject))
    stale_finish = model_tool(prefix + "of_work_finish", {})
    assert stale_finish["state"] == "needs_review", stale_finish
    # Readback still passes, so this refusal specifically tests the subject digest.
    assert subject["status"] == "corrected" and subject["value"] == 1
    stale_readback = model_tool(prefix + "of_work_status", {})
    assert stale_readback["backendState"] == "needs_review", stale_readback
    # Revoke an actual persisted execution grant while the portable server stays enabled.
    _, _, revocation_grants = activate_case("revocation")
    execution_grant = next(grant for grant in revocation_grants if grant["purpose"] == "execution")
    cli("work", "grants", "revoke", "--config", str(config_path), "--grant", execution_grant["id"])
    denied = model_tool(prefix + "of_work_step", {"stepKey": "inspect", "params": {}}, allow_error=True)
    assert "grant" in denied.get("error", "").lower(), denied
    def interrupt_after_effect(case, case_workspace, case_fixture, expected_digest):
        (case_workspace / "park-after-effect").write_text("park")
        interrupted = []
        with patch("tools.approval_prompt.request_elicitation_consent", return_value="accept"):
            thread = threading.Thread(target=lambda: interrupted.append(registry.dispatch(prefix + "of_work_step", {"stepKey": "correct", "params": {"expectedDigest": expected_digest}})), daemon=True)
            thread.start()
            deadline = time.monotonic() + 20
            while not (case_workspace / "effect-ready").exists():
                assert time.monotonic() < deadline, "Unknown-effect fixture never entered its post-effect barrier"
                time.sleep(0.025)
            mtime = case_fixture.stat().st_mtime_ns
            killed = kill_work_process(case_workspace)
            thread.join(timeout=40)
            assert not thread.is_alive(), "Host did not settle the dead write RPC"
        assert interrupted and "error" in json.loads(interrupted[0]), interrupted
        shutdown_mcp_servers()
        execution_root = data_root / (case + "-runtime") / "attempts" / "executions"
        preserved = {path: path.read_bytes() for path in execution_root.glob("*.jsonl")}
        assert preserved, "Interrupted execution journal missing"
        events = [json.loads(line) for content in preserved.values() for line in content.splitlines()]
        originals = [event for event in events if event["type"] == "started" and event["data"].get("receipt", {}).get("toolName") == "fixture_correct"]
        assert len(originals) == 1, originals
        original = originals[0]
        assert original["data"]["receipt"]["executionOutcome"] == "unknown", original
        assert not any(event["executionId"] == original["executionId"] and event["type"] == "settled" for event in events), events
        register_mcp_servers(servers)
        return {"mtime": mtime, "killed": killed, "original": original, "preserved": preserved, "interrupted": interrupted[0]}

    def assert_original_retained(crash):
        for path, content in crash["preserved"].items():
            assert path.read_bytes().startswith(content), "Reconciliation rewrote original execution evidence"
        current = [json.loads(line) for path in crash["preserved"] for line in path.read_bytes().splitlines()]
        own = [event for event in current if event["executionId"] == crash["original"]["executionId"]]
        assert own[-1] == crash["original"] and own[-1]["data"]["receipt"]["executionOutcome"] == "unknown", own
        assert not any(event["type"] == "settled" for event in own), own
        return current

    unknown_workspace, unknown_fixture, _ = activate_case("uncertain", {"status": "needs_correction", "value": 0})
    inspected_unknown = model_tool(prefix + "of_work_step", {"stepKey": "inspect", "params": {}})
    unknown_crash = interrupt_after_effect("uncertain", unknown_workspace, unknown_fixture, inspected_unknown["result"]["data"]["expectedDigest"])
    unknown_recovery = model_tool(prefix + "of_work_reconcile", {})
    assert unknown_recovery["state"] == "reconciliation_required", unknown_recovery
    assert unknown_crash["original"]["executionId"] in unknown_recovery["unknownExecutions"], unknown_recovery
    assert unknown_crash["original"]["executionId"] not in unknown_recovery["effectResolutions"], unknown_recovery
    blocked_finish = model_tool(prefix + "of_work_finish", {}, allow_error=True)
    assert "error" in blocked_finish, blocked_finish
    assert unknown_fixture.stat().st_mtime_ns == unknown_crash["mtime"], "Unsupported unknown effect was automatically repeated"
    assert_original_retained(unknown_crash)

    oracle_workspace, oracle_fixture, _ = activate_case("oracle", {"status": "needs_correction", "value": 0})
    inspected_oracle = model_tool(prefix + "of_work_step", {"stepKey": "inspect", "params": {}})
    oracle_crash = interrupt_after_effect("oracle", oracle_workspace, oracle_fixture, inspected_oracle["result"]["data"]["expectedDigest"])
    before_oracle = model_tool(prefix + "of_work_status", {})
    assert before_oracle["state"] == "reconciliation_required", before_oracle
    assert not before_oracle["effectResolutions"], "Status implicitly ran the effect oracle"
    oracle_recovery = model_tool(prefix + "of_work_reconcile", {})
    assert oracle_recovery["state"] == "running" and not oracle_recovery["unknownExecutions"] and not oracle_recovery["inflightStepIds"], oracle_recovery
    resolution = oracle_recovery["effectResolutions"][oracle_crash["original"]["executionId"]]
    assert resolution["effect"] == "verified" and resolution["sourceRefs"], resolution
    assert resolution["readbackExecutionId"] != oracle_crash["original"]["executionId"], resolution
    current_events = assert_original_retained(oracle_crash)
    readback = next(event for event in current_events if event["executionId"] == resolution["readbackExecutionId"] and event["type"] == "settled")
    assert readback["data"]["receipt"]["executionOutcome"] == "succeeded" and readback["data"]["result"]["data"]["effect"] == "verified", readback
    work_events = [json.loads(line) for path in (data_root / "oracle-runtime" / "attempts").glob("*.jsonl") for line in path.read_bytes().splitlines()]
    assert any(event["data"].get("originalExecutionId") == oracle_crash["original"]["executionId"] and event["data"].get("readbackExecutionId") == resolution["readbackExecutionId"] and event["data"].get("disposition") == "effect_independently_verified" for event in work_events), work_events
    assert oracle_fixture.stat().st_mtime_ns == oracle_crash["mtime"], "Supported oracle repeated the original effect"
    oracle_verified = model_tool(prefix + "of_work_verify", {"stepId": "fixture-check"})
    assert oracle_verified["outcome"] == "passed", oracle_verified
    oracle_finished = model_tool(prefix + "of_work_finish", {})
    assert oracle_finished["state"] == "completed", oracle_finished
    assert_original_retained(oracle_crash)
    assert oracle_fixture.stat().st_mtime_ns == oracle_crash["mtime"], "Completion repeated the original effect"
    return {"state": "completed", "preview": preview, "grants": grants, "start": started, "correct": corrected, "reconcile": recovered, "verification": verified, "staleSubjectRefusal": stale_finish, "staleBackendReadback": stale_readback, "finish": finished, "revocation": denied, "workConfig": str(completed_config), "workspace": str(workspace), "killedProcess": killed, "longStepRenewal": "passed", "knownResultRecovery": "passed with exact saved result and execution ID replay", "lostDelivery": "passed at host/model delivery boundary after real RPC response", "lostDeliveryResult": lost_delivery, "unknownEffect": "passed without a trusted oracle", "unknownRecovery": unknown_recovery, "unknownFinish": blocked_finish, "unknownKilledProcess": unknown_crash["killed"], "oracleEffectRecovery": {"state": "passed", "originalUnknownReceipt": oracle_crash["original"]["data"]["receipt"], "beforeExplicitReconcile": before_oracle, "reconcile": oracle_recovery, "verification": oracle_verified, "finish": oracle_finished, "originalJournalPreserved": True, "effectRepeated": False}}

try:
    from run_agent import AIAgent
    agent = AIAgent(base_url=f"http://127.0.0.1:{local_model.server_port}/v1", api_key="local-fixture-only", provider="custom", api_mode="chat_completions", model="local-proof", enabled_toolsets=["mcp-openfunctions"], max_iterations=3, quiet_mode=True, skip_context_files=True, skip_memory=True, skip_background_review=True, save_trajectories=False, cwd=str(home))
    with patch("tools.approval_prompt.request_elicitation_consent", side_effect=AssertionError("Read requested approval")):
        turn = agent.run_conversation("Read the isolated fixture count with the smoke_read tool.", system_message="Use the provided tool to read the fixture. Report its result.")
    assert turn["final_response"] == "HERMES_LOCAL_PROOF_DONE", turn
    tool_messages = [message for message in turn["messages"] if message["role"] == "tool"]
    assert tool_messages and "count" in str(tool_messages[0]["content"]), turn
    assert "error" not in str(tool_messages[0]["content"]), turn
    assert len(model_requests) >= 2
    with patch("tools.approval_prompt.request_elicitation_consent", side_effect=AssertionError("Read requested approval")):
        read_result = registry.dispatch(read_name, {})
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="decline") as consent:
        refused = registry.dispatch(write_name, {})
    assert consent.call_count == 1
    assert "error" in json.loads(refused)
    assert not Path(inputs["effect"]).exists(), "Refused write reached server dispatch"
    with patch("tools.approval_prompt.request_elicitation_consent", return_value="accept") as consent:
        approved = registry.dispatch(write_name, {})
    assert consent.call_count == 1
    assert "error" not in json.loads(approved)
    assert len(Path(inputs["effect"]).read_text().splitlines()) == 1
    package = load_agent_plugin(Path(inputs["plugin"]), home / "plugin-data")
    assert not package.diagnostics, package.diagnostics
    assert package.mcp_servers["openfunctions"]["trust"] == "untrusted"
    assert package.skills[0].name == "durable-work"
    portable = "not run"
    work = None
    if inputs["mode"] != "smoke":
        # A pinned catalog snapshot keeps this local-only host lane offline while
        # preserving Hermes's ordinary catalog/recall checks during installation.
        from dataclasses import asdict
        from hermes_cli.plugin_catalog import load_catalog, load_removed_list
        cache = home / "cache" / "plugin-catalog.json"
        cache.parent.mkdir(exist_ok=True)
        cache.write_text(json.dumps({"entries": [asdict(entry) for entry in load_catalog()], "removed": [asdict(entry) for entry in load_removed_list()]}))
        from hermes_cli.plugins_cmd import cmd_install, cmd_enable
        from hermes_cli.plugins import PluginManager
        cmd_install(inputs["pluginSource"], enable=False, ref=inputs["pluginRef"])
        disabled = PluginManager()
        disabled.discover_and_load()
        assert not disabled.get_portable_mcp_servers(), "Install enabled plugin without consent"
        assert not any(entry["name"].endswith(":durable-work") for entry in disabled.list_plugin_skill_metadata())
        cmd_enable("openfunctions")
        enabled = PluginManager()
        enabled.discover_and_load()
        skill_metadata = [entry for entry in enabled.list_plugin_skill_metadata() if entry["name"].endswith(":durable-work")]
        assert len(skill_metadata) == 1, enabled.list_plugin_skill_metadata()
        assert skill_metadata[0]["name"].startswith("agent-plugin-openfunctions-"), skill_metadata
        assert enabled.find_plugin_skill(skill_metadata[0]["name"]).is_file()
        servers = enabled.get_portable_mcp_servers()
        assert servers["openfunctions"]["trust"] == "untrusted"
        assert servers["openfunctions"]["command"] == "openfunction"
        assert str(home) in servers["openfunctions"]["cwd"]
        other_home = Path(inputs["scratch"]) / "profile-b"
        other_home.mkdir()
        other = PluginManager(scope_key=str(other_home))
        other.discover_and_load()
        assert not other.get_portable_mcp_servers(), "Plugin crossed isolated profiles"
        assert not any(entry["name"].endswith(":durable-work") for entry in other.list_plugin_skill_metadata())
        portable = "passed"
        if inputs["mode"] == "work":
            work = work_proof(servers)
    evidence = {
        "hermesCommit": inputs["pin"], "python": sys.version,
        "pythonExecutable": sys.executable, "mcp": importlib.metadata.version("mcp"),
        "openfunctionBinary": inputs["binary"], "mode": inputs["mode"],
        "openfunctionTarball": inputs["tarball"], "openfunctionTarballSha256": inputs["tarballSha256"],
        "nodeMcpSdk": inputs["nodeMcpSdk"], "optionalBackendsInstalled": inputs["optionalBackendsInstalled"],
        "nodeRuntime": json.loads(subprocess.check_output(["node", "-p", "JSON.stringify({version:process.version,executable:process.execPath})"], text=True)),
        "discoveredTools": names, "readResult": read_result, "approvedResult": approved,
        "refusedResult": refused, "approvedEffects": 1, "refusalEffects": 0,
        "portableManifestValidated": True,
        "modelUrl": f"http://127.0.0.1:{local_model.server_port}/v1", "localModelRequests": len(model_requests), "modelTurn": turn,
        "work": work,
        "boundaries": {"ordinaryMcp": "passed", "portableInstall": portable, "portableWorkServer": "passed" if work else "not run", "localModelTurn": "passed", "durableWork": "passed" if work else "not run"},
    }
    (Path(inputs["scratch"]) / "evidence.json").write_text(json.dumps(evidence, indent=2))
finally:
    local_model.shutdown()
    shutdown_mcp_servers()
