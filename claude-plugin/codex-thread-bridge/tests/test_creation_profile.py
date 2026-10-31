import pytest


async def test_creation_effort_preserves_workspace_policy_and_receipt(
    bridge, fake_server, tmp_path
):
    fake, _ = fake_server
    policy = {
        "type": "workspaceWrite",
        "writableRoots": [str(tmp_path)],
        "networkAccess": True,
        "excludeTmpdirEnvVar": False,
        "excludeSlashTmp": False,
    }
    args = dict(
        request_id="profile",
        cwd=str(tmp_path),
        prompt="READY",
        model="gpt-5.6-sol",
        reasoning_effort="medium",
        sandbox="workspace-write",
        sandbox_policy=policy,
    )
    receipt = await bridge.create_thread(**args)
    assert receipt["status"] == "accepted"
    assert receipt["creation"]["reasoningEffort"] == "medium"
    assert receipt["creation"]["sandbox"] == policy
    assert (await bridge.create_thread(**args))["replayed"]
    with pytest.raises(ValueError):
        await bridge.create_thread(**{**args, "reasoning_effort": "high"})
    assert fake.count("thread/start") == 1
    assert fake.count("turn/start") == 1


@pytest.mark.parametrize("override", [{"reasoningEffort": "high"}, {"model": "other"}])
async def test_creation_profile_mismatch_retains_id_without_dispatch(
    bridge, fake_server, tmp_path, override
):
    fake, _ = fake_server
    fake.override_creation = override
    receipt = await bridge.create_thread(
        "mismatch",
        str(tmp_path),
        prompt="DO WORK",
        model="gpt-5.6-sol",
        reasoning_effort="medium",
    )
    assert receipt["status"] == "failed"
    assert receipt["threadId"]
    assert fake.count("turn/start") == 0


async def test_empty_effort_rejected_before_creation(bridge, fake_server, tmp_path):
    fake, _ = fake_server
    with pytest.raises(ValueError):
        await bridge.create_thread("invalid", str(tmp_path), reasoning_effort=" ")
    assert fake.count("thread/start") == 0
