"""Explicit, retained Git worktrees; no Desktop ownership or cleanup policy."""

import asyncio
import os
import re
from dataclasses import dataclass
from pathlib import Path


class WorktreeError(Exception):
    """A rejected Git contract or a known Git failure; partial artifacts may remain."""


async def git(cwd: Path, *args: str) -> str:
    # Inherited repository/index/config overrides must not redirect our Git commands.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_NO_LAZY_FETCH="1")
    process = await asyncio.create_subprocess_exec(
        "git",
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        f"core.hooksPath={os.devnull}",
        "-c",
        "submodule.recurse=false",
        "-c",
        "core.fsmonitor=false",
        "-C",
        str(cwd),
        *args,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.communicate()
        raise
    if process.returncode:
        raise WorktreeError(stderr.decode(errors="replace")[-4000:].strip())
    # Remove Git's output terminator without stripping whitespace from paths.
    return stdout.decode().removesuffix("\n")


def canonical_path(value: str, name: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or str(path.resolve()) != value:
        raise WorktreeError(f"{name} must be a canonical absolute path without symlinks")
    return path


async def checkout_filter_config(cwd: Path) -> tuple[str, ...]:
    # Disable configured filters explicitly; checkout contains repository blobs.
    config = await git(cwd, "config", "--null", "--list")
    filters = set()
    for entry in config.split("\0"):
        key = entry.partition("\n")[0]
        if re.fullmatch(r"filter\..*\.(clean|smudge|process|required)", key):
            filters.add(key.rsplit(".", 1)[0])
    overrides = tuple(
        arg
        for name in sorted(filters)
        for setting in ("clean=", "smudge=", "process=", "required=false")
        for arg in ("-c", f"{name}.{setting}")
    )
    return overrides


@dataclass(frozen=True)
class Worktree:
    source: Path
    destination: Path
    revision: str
    common_dir: Path

    @classmethod
    async def validate(cls, source_repository: str, starting_revision: str, destination: str):
        source = canonical_path(source_repository, "source_repository")
        target = canonical_path(destination, "destination")
        if not source.is_dir():
            raise WorktreeError("source_repository must be an existing Git checkout root")
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", starting_revision):
            raise WorktreeError("starting_revision must be a full lowercase commit object ID")
        root = await git(source, "rev-parse", "--show-toplevel")
        if root != str(source):
            raise WorktreeError("source_repository must be the Git checkout root")
        if await git(source, "cat-file", "-t", starting_revision) != "commit":
            raise WorktreeError("starting_revision must name a commit object")
        common = Path(await git(source, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        if target.exists() or target.is_symlink() or not target.parent.is_dir():
            raise WorktreeError("destination must be absent with an existing parent directory")
        for parent in target.parents:
            if (parent / ".git").exists() or (
                (parent / "HEAD").is_file() and (parent / "objects").is_dir()
            ):
                raise WorktreeError("destination must be outside existing repositories")
        worktrees = await git(source, "worktree", "list", "--porcelain", "-z")
        roots = [
            Path(field[9:]) for field in worktrees.split("\0") if field.startswith("worktree ")
        ]
        if any(target.is_relative_to(path.resolve()) for path in [common, *roots]):
            raise WorktreeError("destination must be outside existing worktrees and Git metadata")
        return cls(source, target, starting_revision, await asyncio.to_thread(common.resolve))

    def receipt(self):
        return {
            "sourceRepository": str(self.source),
            "checkout": str(self.destination),
            "requestedRevision": self.revision,
            "gitCommonDirectory": str(self.common_dir),
            "ownership": "bridge-managed",
            "lifecycle": "retained-until-manual-cleanup",
            "state": "planned",
        }

    def reserve(self):
        # Exclusive mkdir prevents concurrent launches from adopting even an empty directory.
        self.destination.mkdir(mode=0o700)

    async def create(self):
        await git(
            self.source,
            "worktree",
            "add",
            "--detach",
            "--no-checkout",
            "--lock",
            "--reason",
            "codex-thread-bridge: retained until manual cleanup",
            "--",
            str(self.destination),
            self.revision,
        )

    async def checkout(self):
        # Conditional includes may apply only to the newly registered worktree.
        overrides = await checkout_filter_config(self.destination)
        await git(self.destination, "read-tree", self.revision)
        await git(self.destination, *overrides, "checkout-index", "--all")

    async def inspect(self):
        overrides = await checkout_filter_config(self.destination)
        return {
            "checkout": await git(self.destination, "rev-parse", "--show-toplevel"),
            "initialRevision": await git(self.destination, "rev-parse", "HEAD"),
            "gitCommonDirectory": await git(
                self.destination, "rev-parse", "--path-format=absolute", "--git-common-dir"
            ),
            "detached": await git(self.destination, "rev-parse", "--abbrev-ref", "HEAD") == "HEAD",
            "clean": not await git(
                self.destination,
                *overrides,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ),
        }

    def matches(self, actual: dict) -> bool:
        return (
            actual["checkout"] == str(self.destination)
            and actual["initialRevision"] == self.revision
            and actual["gitCommonDirectory"] == str(self.common_dir)
            and actual["detached"]
            and actual["clean"]
            and self.destination.resolve() == self.destination
        )
