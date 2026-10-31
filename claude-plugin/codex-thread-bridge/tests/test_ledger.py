import hashlib

import pytest

from codex_thread_bridge.ledger import Ledger, open_endpoint_ledger


def old_ledger_path(state, socket):
    digest = hashlib.sha256(str(socket.absolute()).encode()).hexdigest()[:16]
    return state / f"operations-{digest}.sqlite3"


def test_socket_aliases_share_ledger_and_retain_identity_after_restart(tmp_path):
    socket = tmp_path / "actual.sock"
    socket.touch()
    alias = tmp_path / "alias.sock"
    alias.symlink_to(socket)
    canonical, ledger = open_endpoint_ledger(alias, tmp_path / "state")
    assert canonical == socket
    _, receipt = ledger.begin("create", "create_thread", {"cwd": "/checkout"})
    ledger.save({**receipt, "threadId": "thread-1", "status": "accepted"})
    ledger.close()
    _, restarted = open_endpoint_ledger(socket, tmp_path / "state")
    try:
        fresh, receipt = restarted.begin("create", "create_thread", {"cwd": "/checkout"})
        assert not fresh and receipt["threadId"] == "thread-1"
        assert len(list((tmp_path / "state").glob("*.sqlite3"))) == 1
    finally:
        restarted.close()


def test_import_legacy_socket_alias_preserves_receipts(tmp_path):
    socket = tmp_path / "actual.sock"
    socket.touch()
    alias = tmp_path / "alias.sock"
    alias.symlink_to(socket)
    state = tmp_path / "state"
    legacy_path = old_ledger_path(state, alias)
    legacy = Ledger(legacy_path)
    _, receipt = legacy.begin("create", "create_thread", {"cwd": "/checkout"})
    legacy.save({**receipt, "threadId": "thread-1", "status": "accepted"})
    legacy.close()
    _, ledger = open_endpoint_ledger(alias, state)
    try:
        assert ledger.get("create")["threadId"] == "thread-1"
        assert legacy_path.exists()
    finally:
        ledger.close()
    # Repeated imports and a subsequent canonical-path startup are safe.
    for spelling in [alias, socket]:
        _, ledger = open_endpoint_ledger(spelling, state)
        try:
            assert not ledger.begin("create", "create_thread", {"cwd": "/checkout"})[0]
        finally:
            ledger.close()


def test_legacy_conflict_stops_and_rolls_back_import(tmp_path):
    socket = tmp_path / "actual.sock"
    socket.touch()
    alias = tmp_path / "alias.sock"
    alias.symlink_to(socket)
    state = tmp_path / "state"
    legacy = Ledger(old_ledger_path(state, alias))
    legacy.begin("only-in-alias", "create_thread", {})
    _, receipt = legacy.begin("same-id", "create_thread", {})
    legacy.save({**receipt, "threadId": "alias-thread"})
    legacy.close()
    _, canonical = open_endpoint_ledger(socket, state)
    _, receipt = canonical.begin("same-id", "create_thread", {})
    canonical.save({**receipt, "threadId": "canonical-thread"})
    canonical.close()
    with pytest.raises(ValueError, match="Conflicting retained request"):
        open_endpoint_ledger(alias, state)
    _, canonical = open_endpoint_ledger(socket, state)
    try:
        assert canonical.get("same-id")["threadId"] == "canonical-thread"
        with pytest.raises(ValueError, match="Unknown request_id"):
            canonical.get("only-in-alias")
    finally:
        canonical.close()
