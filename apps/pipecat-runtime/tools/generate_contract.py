"""Generate the private Python binding for the published conversation contract."""

from __future__ import annotations

from pathlib import Path

from grpc_tools import protoc


def main() -> None:
    """Generate gRPC modules without modifying either repository-owned source contract."""
    app_root = Path(__file__).resolve().parents[1]
    repository_root = app_root.parents[1]
    _generate_binding(
        proto_root=repository_root / "packages" / "conversation-runtime-contracts" / "proto",
        proto_file_name="conversation_runtime.proto",
        output_root=app_root
        / "src"
        / "pipecat_runtime"
        / "adapters"
        / "grpc"
        / "generated",
    )
    _generate_binding(
        proto_root=repository_root / "apps" / "meeting-platform" / "proto",
        proto_file_name="agent_runtime.proto",
        output_root=app_root
        / "src"
        / "pipecat_runtime"
        / "adapters"
        / "subscription_runtime"
        / "generated",
    )


def _generate_binding(
    *,
    proto_root: Path,
    proto_file_name: str,
    output_root: Path,
) -> None:
    """Generate one Python binding and make its generated sibling import package-relative."""
    proto_file = proto_root / proto_file_name
    output_root.mkdir(parents=True, exist_ok=True)
    (output_root / "__init__.py").touch()

    result = protoc.main(
        [
            "grpc_tools.protoc",
            f"-I{proto_root}",
            f"--python_out={output_root}",
            f"--pyi_out={output_root}",
            f"--grpc_python_out={output_root}",
            str(proto_file),
        ]
    )
    if result != 0:
        message = f"Unable to generate {proto_file_name} gRPC binding"
        raise SystemExit(message)

    module_name = proto_file.stem
    grpc_file = output_root / f"{module_name}_pb2_grpc.py"
    generated = grpc_file.read_text(encoding="utf-8")
    grpc_file.write_text(
        generated.replace(
            f"import {module_name}_pb2 as {module_name.replace('_', '__')}__pb2",
            f"from . import {module_name}_pb2 as {module_name.replace('_', '__')}__pb2",
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
