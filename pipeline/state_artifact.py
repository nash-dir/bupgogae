"""Authenticated, run-bound private state handoffs for public Actions runners.

Only ciphertext is uploaded. The state transport key grants no R2 access. Never
extract before GCM authentication, and never accept arbitrary archive paths.
"""
import argparse
import base64
import binascii
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import zipfile

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b"BUPSTATE1"
CHUNK = 1024 * 1024
LIMITS = {
    "master.db": 4 * 1024**3,
    "failed_dates.json": 16 * 1024**2,
    "state-mode.json": 64 * 1024,
    "pipeline-report.json": 16 * 1024,
}
MAX_ARCHIVE = sum(LIMITS.values()) + 64 * 1024**2


def transport_key():
    try:
        key = base64.b64decode(os.environ.get("STATE_ARTIFACT_KEY", ""), validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("invalid_state_transport_key") from None
    if len(key) != 32:
        raise ValueError("invalid_state_transport_key")
    return key


def context(phase):
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    run = os.environ.get("GITHUB_RUN_ID", "")
    sha = os.environ.get("GITHUB_SHA", "")
    if (phase not in {"input", "resume"}
            or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
            or not re.fullmatch(r"[0-9]{1,32}", run)
            or not re.fullmatch(r"[0-9a-f]{40}", sha)):
        raise ValueError("invalid_state_transport_context")
    # Bind run/revision/direction. Rerunning only a failed job may legitimately
    # consume a preceding attempt's artifact ID within this same run/revision.
    return f"bupgogae-state-v1\n{repo}\n{run}\n{sha}\n{phase}".encode("ascii")


def _check_members(archive):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if (not entries or len(names) != len(set(names))
            or any(name not in LIMITS for name in names)
            or not ({"master.db", "state-mode.json"} & set(names))):
        raise ValueError("invalid_state_archive_members")
    for entry in entries:
        if (entry.is_dir() or (entry.external_attr >> 16) & 0o170000 == 0o120000
                or entry.file_size > LIMITS[entry.filename]):
            raise ValueError("invalid_state_archive_entry")
    return entries


def seal(data_dir, output, phase):
    key, aad = transport_key(), context(phase)
    data_dir, output = Path(data_dir), Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".state-seal-", dir=output.parent) as temp:
        temp = Path(temp)
        master = data_dir / "master.db"
        if master.exists():
            if master.is_symlink() or master.stat().st_size > LIMITS["master.db"]:
                raise ValueError("invalid_state_master")
            wal = Path(str(master) + "-wal")
            if wal.exists() and wal.stat().st_size:
                # Capture committed WAL rows rather than a partial file set.
                source = sqlite3.connect(master.resolve().as_uri() + "?mode=ro", uri=True)
                target = sqlite3.connect(temp / "master.db")
                try:
                    source.backup(target)
                finally:
                    target.close()
                    source.close()
            else:
                # Producers are sequential, closed crawler/download steps. Retain
                # exact snapshot bytes (SQLite backup may rewrite header counters).
                before = master.stat()
                shutil.copyfile(master, temp / "master.db")
                after = master.stat()
                if ((before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
                        or (wal.exists() and wal.stat().st_size)):
                    raise ValueError("state_changed_during_handoff")
        archive_path = temp / "state.zip"
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, limit in LIMITS.items():
                path = temp / name if name == "master.db" else data_dir / name
                if not path.exists():
                    continue
                if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
                    raise ValueError("invalid_state_source")
                archive.write(path, name)
            _check_members(archive)
        if archive_path.stat().st_size > MAX_ARCHIVE:
            raise ValueError("state_archive_too_large")
        nonce = os.urandom(12)
        encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
        encryptor.authenticate_additional_data(aad)
        encrypted = temp / "state.aead"
        with archive_path.open("rb") as source, encrypted.open("wb") as dest:
            dest.write(MAGIC + nonce)
            while block := source.read(CHUNK):
                dest.write(encryptor.update(block))
            dest.write(encryptor.finalize())
            dest.write(encryptor.tag)
        os.chmod(encrypted, 0o600)
        os.replace(encrypted, output)


def unseal(source, data_dir, phase):
    key, aad = transport_key(), context(phase)
    source, data_dir = Path(source), Path(data_dir)
    overhead = len(MAGIC) + 12 + 16
    size = source.stat().st_size
    if source.is_symlink() or not overhead < size <= MAX_ARCHIVE + overhead:
        raise ValueError("invalid_state_ciphertext_size")
    if data_dir.exists():
        raise ValueError("state_destination_already_exists")
    data_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".state-open-", dir=data_dir.parent) as temp:
        temp = Path(temp)
        archive_path = temp / "authenticated.zip"
        with source.open("rb") as encrypted:
            if encrypted.read(len(MAGIC)) != MAGIC:
                raise ValueError("invalid_state_ciphertext_header")
            nonce = encrypted.read(12)
            encrypted.seek(-16, os.SEEK_END)
            tag = encrypted.read(16)
            encrypted.seek(len(MAGIC) + 12)
            decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
            decryptor.authenticate_additional_data(aad)
            remaining = size - overhead
            with archive_path.open("wb") as dest:
                while remaining:
                    block = encrypted.read(min(CHUNK, remaining))
                    if not block:
                        raise ValueError("truncated_state_ciphertext")
                    dest.write(decryptor.update(block))
                    remaining -= len(block)
                dest.write(decryptor.finalize())  # InvalidTag => nothing is extracted.
        restored = temp / "restored"
        restored.mkdir(mode=0o700)
        with zipfile.ZipFile(archive_path) as archive:
            entries = _check_members(archive)
            for entry in entries:
                written = 0
                with archive.open(entry) as content, (restored / entry.filename).open("xb") as dest:
                    while block := content.read(CHUNK):
                        written += len(block)
                        if written > LIMITS[entry.filename]:
                            raise ValueError("state_entry_too_large")
                        dest.write(block)
                os.chmod(restored / entry.filename, 0o600)
        os.replace(restored, data_dir)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["seal", "unseal"])
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--phase", choices=["input", "resume"], required=True)
    args = parser.parse_args()
    try:
        if args.action == "seal":
            seal(args.dir, args.file, args.phase)
        else:
            unseal(args.file, args.dir, args.phase)
    except Exception as error:
        # Never serialize exception strings, paths, key bytes, URLs or plaintext.
        parser.exit(1, f"state transport failed ({type(error).__name__})\n")
    print("authenticated state handoff complete")


if __name__ == "__main__":
    main()
