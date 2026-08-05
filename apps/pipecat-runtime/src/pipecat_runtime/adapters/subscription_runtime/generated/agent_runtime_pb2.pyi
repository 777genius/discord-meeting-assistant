from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class AgentRuntimeProvider(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_RUNTIME_PROVIDER_UNSPECIFIED: _ClassVar[AgentRuntimeProvider]
    AGENT_RUNTIME_PROVIDER_CODEX: _ClassVar[AgentRuntimeProvider]
    AGENT_RUNTIME_PROVIDER_CLAUDE: _ClassVar[AgentRuntimeProvider]

class AgentRuntimeTaskStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_RUNTIME_TASK_STATUS_UNSPECIFIED: _ClassVar[AgentRuntimeTaskStatus]
    AGENT_RUNTIME_TASK_STATUS_COMPLETED: _ClassVar[AgentRuntimeTaskStatus]
    AGENT_RUNTIME_TASK_STATUS_FAILED: _ClassVar[AgentRuntimeTaskStatus]
    AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT: _ClassVar[AgentRuntimeTaskStatus]

class AgentRuntimeSelectedOutputKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_RUNTIME_SELECTED_OUTPUT_KIND_UNSPECIFIED: _ClassVar[AgentRuntimeSelectedOutputKind]
    AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT: _ClassVar[AgentRuntimeSelectedOutputKind]
    AGENT_RUNTIME_SELECTED_OUTPUT_KIND_OUTPUT_TEXT: _ClassVar[AgentRuntimeSelectedOutputKind]

class AgentRuntimeHealthStatus(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_RUNTIME_HEALTH_STATUS_UNSPECIFIED: _ClassVar[AgentRuntimeHealthStatus]
    AGENT_RUNTIME_HEALTH_STATUS_SERVING: _ClassVar[AgentRuntimeHealthStatus]
    AGENT_RUNTIME_HEALTH_STATUS_DEGRADED: _ClassVar[AgentRuntimeHealthStatus]
    AGENT_RUNTIME_HEALTH_STATUS_NOT_SERVING: _ClassVar[AgentRuntimeHealthStatus]

class AgentRuntimeTokenAvailability(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_RUNTIME_TOKEN_AVAILABILITY_UNSPECIFIED: _ClassVar[AgentRuntimeTokenAvailability]
    AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED: _ClassVar[AgentRuntimeTokenAvailability]
    AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED: _ClassVar[AgentRuntimeTokenAvailability]
    AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE: _ClassVar[AgentRuntimeTokenAvailability]

class AgentRuntimeDerivedTokenSource(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_UNSPECIFIED: _ClassVar[AgentRuntimeDerivedTokenSource]
    AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT: _ClassVar[AgentRuntimeDerivedTokenSource]
    AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT: _ClassVar[AgentRuntimeDerivedTokenSource]
AGENT_RUNTIME_PROVIDER_UNSPECIFIED: AgentRuntimeProvider
AGENT_RUNTIME_PROVIDER_CODEX: AgentRuntimeProvider
AGENT_RUNTIME_PROVIDER_CLAUDE: AgentRuntimeProvider
AGENT_RUNTIME_TASK_STATUS_UNSPECIFIED: AgentRuntimeTaskStatus
AGENT_RUNTIME_TASK_STATUS_COMPLETED: AgentRuntimeTaskStatus
AGENT_RUNTIME_TASK_STATUS_FAILED: AgentRuntimeTaskStatus
AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT: AgentRuntimeTaskStatus
AGENT_RUNTIME_SELECTED_OUTPUT_KIND_UNSPECIFIED: AgentRuntimeSelectedOutputKind
AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT: AgentRuntimeSelectedOutputKind
AGENT_RUNTIME_SELECTED_OUTPUT_KIND_OUTPUT_TEXT: AgentRuntimeSelectedOutputKind
AGENT_RUNTIME_HEALTH_STATUS_UNSPECIFIED: AgentRuntimeHealthStatus
AGENT_RUNTIME_HEALTH_STATUS_SERVING: AgentRuntimeHealthStatus
AGENT_RUNTIME_HEALTH_STATUS_DEGRADED: AgentRuntimeHealthStatus
AGENT_RUNTIME_HEALTH_STATUS_NOT_SERVING: AgentRuntimeHealthStatus
AGENT_RUNTIME_TOKEN_AVAILABILITY_UNSPECIFIED: AgentRuntimeTokenAvailability
AGENT_RUNTIME_TOKEN_AVAILABILITY_MEASURED: AgentRuntimeTokenAvailability
AGENT_RUNTIME_TOKEN_AVAILABILITY_DERIVED: AgentRuntimeTokenAvailability
AGENT_RUNTIME_TOKEN_AVAILABILITY_UNAVAILABLE: AgentRuntimeTokenAvailability
AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_UNSPECIFIED: AgentRuntimeDerivedTokenSource
AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_INPUT: AgentRuntimeDerivedTokenSource
AGENT_RUNTIME_DERIVED_TOKEN_SOURCE_OUTPUT: AgentRuntimeDerivedTokenSource

class AgentRuntimeTaskRequest(_message.Message):
    __slots__ = ("schema_version", "request_id", "tenant_id", "workspace_id", "correlation_id", "provider", "provider_instance_id", "purpose", "system_prompt", "prompt", "output_schema_json", "controls_json", "timeout_ms", "cwd", "metadata")
    class MetadataEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    SCHEMA_VERSION_FIELD_NUMBER: _ClassVar[int]
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    CORRELATION_ID_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_INSTANCE_ID_FIELD_NUMBER: _ClassVar[int]
    PURPOSE_FIELD_NUMBER: _ClassVar[int]
    SYSTEM_PROMPT_FIELD_NUMBER: _ClassVar[int]
    PROMPT_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_SCHEMA_JSON_FIELD_NUMBER: _ClassVar[int]
    CONTROLS_JSON_FIELD_NUMBER: _ClassVar[int]
    TIMEOUT_MS_FIELD_NUMBER: _ClassVar[int]
    CWD_FIELD_NUMBER: _ClassVar[int]
    METADATA_FIELD_NUMBER: _ClassVar[int]
    schema_version: int
    request_id: str
    tenant_id: str
    workspace_id: str
    correlation_id: str
    provider: AgentRuntimeProvider
    provider_instance_id: str
    purpose: str
    system_prompt: str
    prompt: str
    output_schema_json: str
    controls_json: str
    timeout_ms: int
    cwd: str
    metadata: _containers.ScalarMap[str, str]
    def __init__(self, schema_version: _Optional[int] = ..., request_id: _Optional[str] = ..., tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., correlation_id: _Optional[str] = ..., provider: _Optional[_Union[AgentRuntimeProvider, str]] = ..., provider_instance_id: _Optional[str] = ..., purpose: _Optional[str] = ..., system_prompt: _Optional[str] = ..., prompt: _Optional[str] = ..., output_schema_json: _Optional[str] = ..., controls_json: _Optional[str] = ..., timeout_ms: _Optional[int] = ..., cwd: _Optional[str] = ..., metadata: _Optional[_Mapping[str, str]] = ...) -> None: ...

class AgentRuntimeTaskStreamRequest(_message.Message):
    __slots__ = ("task",)
    TASK_FIELD_NUMBER: _ClassVar[int]
    task: AgentRuntimeTaskRequest
    def __init__(self, task: _Optional[_Union[AgentRuntimeTaskRequest, _Mapping]] = ...) -> None: ...

class AgentRuntimeTaskResponse(_message.Message):
    __slots__ = ("schema_version", "status", "output_text", "structured_output_json", "warnings", "usage", "failure", "execution_attestation", "telemetry")
    SCHEMA_VERSION_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TEXT_FIELD_NUMBER: _ClassVar[int]
    STRUCTURED_OUTPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    USAGE_FIELD_NUMBER: _ClassVar[int]
    FAILURE_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_ATTESTATION_FIELD_NUMBER: _ClassVar[int]
    TELEMETRY_FIELD_NUMBER: _ClassVar[int]
    schema_version: int
    status: AgentRuntimeTaskStatus
    output_text: str
    structured_output_json: str
    warnings: _containers.RepeatedCompositeFieldContainer[AgentRuntimeWarning]
    usage: AgentRuntimeUsage
    failure: AgentRuntimeFailure
    execution_attestation: AgentRuntimeExecutionAttestation
    telemetry: AgentRuntimeTelemetry
    def __init__(self, schema_version: _Optional[int] = ..., status: _Optional[_Union[AgentRuntimeTaskStatus, str]] = ..., output_text: _Optional[str] = ..., structured_output_json: _Optional[str] = ..., warnings: _Optional[_Iterable[_Union[AgentRuntimeWarning, _Mapping]]] = ..., usage: _Optional[_Union[AgentRuntimeUsage, _Mapping]] = ..., failure: _Optional[_Union[AgentRuntimeFailure, _Mapping]] = ..., execution_attestation: _Optional[_Union[AgentRuntimeExecutionAttestation, _Mapping]] = ..., telemetry: _Optional[_Union[AgentRuntimeTelemetry, _Mapping]] = ...) -> None: ...

class AgentRuntimeTaskEvent(_message.Message):
    __slots__ = ("schema_version", "sequence", "started", "text_delta", "completed")
    SCHEMA_VERSION_FIELD_NUMBER: _ClassVar[int]
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    STARTED_FIELD_NUMBER: _ClassVar[int]
    TEXT_DELTA_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    schema_version: int
    sequence: int
    started: AgentRuntimeTaskStarted
    text_delta: AgentRuntimeTextDelta
    completed: AgentRuntimeTaskResponse
    def __init__(self, schema_version: _Optional[int] = ..., sequence: _Optional[int] = ..., started: _Optional[_Union[AgentRuntimeTaskStarted, _Mapping]] = ..., text_delta: _Optional[_Union[AgentRuntimeTextDelta, _Mapping]] = ..., completed: _Optional[_Union[AgentRuntimeTaskResponse, _Mapping]] = ...) -> None: ...

class AgentRuntimeTaskStarted(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class AgentRuntimeTextDelta(_message.Message):
    __slots__ = ("text",)
    TEXT_FIELD_NUMBER: _ClassVar[int]
    text: str
    def __init__(self, text: _Optional[str] = ...) -> None: ...

class AgentRuntimeExecutionAttestation(_message.Message):
    __slots__ = ("schema_version", "request_id", "purpose", "canonical_request_sha256", "provider", "model", "reasoning_effort", "runtime_engine", "runtime_package_version", "launcher_sha256", "selected_output_kind", "selected_output_sha256")
    SCHEMA_VERSION_FIELD_NUMBER: _ClassVar[int]
    REQUEST_ID_FIELD_NUMBER: _ClassVar[int]
    PURPOSE_FIELD_NUMBER: _ClassVar[int]
    CANONICAL_REQUEST_SHA256_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    MODEL_FIELD_NUMBER: _ClassVar[int]
    REASONING_EFFORT_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ENGINE_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_PACKAGE_VERSION_FIELD_NUMBER: _ClassVar[int]
    LAUNCHER_SHA256_FIELD_NUMBER: _ClassVar[int]
    SELECTED_OUTPUT_KIND_FIELD_NUMBER: _ClassVar[int]
    SELECTED_OUTPUT_SHA256_FIELD_NUMBER: _ClassVar[int]
    schema_version: int
    request_id: str
    purpose: str
    canonical_request_sha256: str
    provider: AgentRuntimeProvider
    model: str
    reasoning_effort: str
    runtime_engine: str
    runtime_package_version: str
    launcher_sha256: str
    selected_output_kind: AgentRuntimeSelectedOutputKind
    selected_output_sha256: str
    def __init__(self, schema_version: _Optional[int] = ..., request_id: _Optional[str] = ..., purpose: _Optional[str] = ..., canonical_request_sha256: _Optional[str] = ..., provider: _Optional[_Union[AgentRuntimeProvider, str]] = ..., model: _Optional[str] = ..., reasoning_effort: _Optional[str] = ..., runtime_engine: _Optional[str] = ..., runtime_package_version: _Optional[str] = ..., launcher_sha256: _Optional[str] = ..., selected_output_kind: _Optional[_Union[AgentRuntimeSelectedOutputKind, str]] = ..., selected_output_sha256: _Optional[str] = ...) -> None: ...

class AgentRuntimeUsage(_message.Message):
    __slots__ = ("input_tokens", "output_tokens", "total_tokens", "estimated_cost_usd", "cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens", "complete")
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_USD_FIELD_NUMBER: _ClassVar[int]
    CACHED_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHE_WRITE_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REASONING_OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COMPLETE_FIELD_NUMBER: _ClassVar[int]
    input_tokens: int
    output_tokens: int
    total_tokens: int
    estimated_cost_usd: float
    cached_input_tokens: int
    cache_write_input_tokens: int
    reasoning_output_tokens: int
    complete: bool
    def __init__(self, input_tokens: _Optional[int] = ..., output_tokens: _Optional[int] = ..., total_tokens: _Optional[int] = ..., estimated_cost_usd: _Optional[float] = ..., cached_input_tokens: _Optional[int] = ..., cache_write_input_tokens: _Optional[int] = ..., reasoning_output_tokens: _Optional[int] = ..., complete: _Optional[bool] = ...) -> None: ...

class AgentRuntimeTokenClass(_message.Message):
    __slots__ = ("availability", "value", "derived_from")
    AVAILABILITY_FIELD_NUMBER: _ClassVar[int]
    VALUE_FIELD_NUMBER: _ClassVar[int]
    DERIVED_FROM_FIELD_NUMBER: _ClassVar[int]
    availability: AgentRuntimeTokenAvailability
    value: int
    derived_from: _containers.RepeatedScalarFieldContainer[AgentRuntimeDerivedTokenSource]
    def __init__(self, availability: _Optional[_Union[AgentRuntimeTokenAvailability, str]] = ..., value: _Optional[int] = ..., derived_from: _Optional[_Iterable[_Union[AgentRuntimeDerivedTokenSource, str]]] = ...) -> None: ...

class AgentRuntimeCostRange(_message.Message):
    __slots__ = ("minimum_usd", "maximum_usd", "has_exact_usd", "exact_usd", "price_card_id", "price_card_source")
    MINIMUM_USD_FIELD_NUMBER: _ClassVar[int]
    MAXIMUM_USD_FIELD_NUMBER: _ClassVar[int]
    HAS_EXACT_USD_FIELD_NUMBER: _ClassVar[int]
    EXACT_USD_FIELD_NUMBER: _ClassVar[int]
    PRICE_CARD_ID_FIELD_NUMBER: _ClassVar[int]
    PRICE_CARD_SOURCE_FIELD_NUMBER: _ClassVar[int]
    minimum_usd: float
    maximum_usd: float
    has_exact_usd: bool
    exact_usd: float
    price_card_id: str
    price_card_source: str
    def __init__(self, minimum_usd: _Optional[float] = ..., maximum_usd: _Optional[float] = ..., has_exact_usd: _Optional[bool] = ..., exact_usd: _Optional[float] = ..., price_card_id: _Optional[str] = ..., price_card_source: _Optional[str] = ...) -> None: ...

class AgentRuntimeTelemetry(_message.Message):
    __slots__ = ("source", "input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens", "cost")
    SOURCE_FIELD_NUMBER: _ClassVar[int]
    INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHED_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    CACHE_WRITE_INPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    REASONING_OUTPUT_TOKENS_FIELD_NUMBER: _ClassVar[int]
    TOTAL_TOKENS_FIELD_NUMBER: _ClassVar[int]
    COST_FIELD_NUMBER: _ClassVar[int]
    source: str
    input_tokens: AgentRuntimeTokenClass
    cached_input_tokens: AgentRuntimeTokenClass
    cache_write_input_tokens: AgentRuntimeTokenClass
    output_tokens: AgentRuntimeTokenClass
    reasoning_output_tokens: AgentRuntimeTokenClass
    total_tokens: AgentRuntimeTokenClass
    cost: AgentRuntimeCostRange
    def __init__(self, source: _Optional[str] = ..., input_tokens: _Optional[_Union[AgentRuntimeTokenClass, _Mapping]] = ..., cached_input_tokens: _Optional[_Union[AgentRuntimeTokenClass, _Mapping]] = ..., cache_write_input_tokens: _Optional[_Union[AgentRuntimeTokenClass, _Mapping]] = ..., output_tokens: _Optional[_Union[AgentRuntimeTokenClass, _Mapping]] = ..., reasoning_output_tokens: _Optional[_Union[AgentRuntimeTokenClass, _Mapping]] = ..., total_tokens: _Optional[_Union[AgentRuntimeTokenClass, _Mapping]] = ..., cost: _Optional[_Union[AgentRuntimeCostRange, _Mapping]] = ...) -> None: ...

class AgentRuntimeFailure(_message.Message):
    __slots__ = ("code", "safe_message", "retryable", "reconnect_required", "cause_category", "details")
    class DetailsEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    CODE_FIELD_NUMBER: _ClassVar[int]
    SAFE_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RETRYABLE_FIELD_NUMBER: _ClassVar[int]
    RECONNECT_REQUIRED_FIELD_NUMBER: _ClassVar[int]
    CAUSE_CATEGORY_FIELD_NUMBER: _ClassVar[int]
    DETAILS_FIELD_NUMBER: _ClassVar[int]
    code: str
    safe_message: str
    retryable: bool
    reconnect_required: bool
    cause_category: str
    details: _containers.ScalarMap[str, str]
    def __init__(self, code: _Optional[str] = ..., safe_message: _Optional[str] = ..., retryable: _Optional[bool] = ..., reconnect_required: _Optional[bool] = ..., cause_category: _Optional[str] = ..., details: _Optional[_Mapping[str, str]] = ...) -> None: ...

class AgentRuntimeWarning(_message.Message):
    __slots__ = ("code", "message")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class AgentRuntimeHealthRequest(_message.Message):
    __slots__ = ("service",)
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    service: str
    def __init__(self, service: _Optional[str] = ...) -> None: ...

class AgentRuntimeHealthResponse(_message.Message):
    __slots__ = ("status", "runtime_engine", "runtime_version", "warnings", "launcher_sha256")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_ENGINE_FIELD_NUMBER: _ClassVar[int]
    RUNTIME_VERSION_FIELD_NUMBER: _ClassVar[int]
    WARNINGS_FIELD_NUMBER: _ClassVar[int]
    LAUNCHER_SHA256_FIELD_NUMBER: _ClassVar[int]
    status: AgentRuntimeHealthStatus
    runtime_engine: str
    runtime_version: str
    warnings: _containers.RepeatedCompositeFieldContainer[AgentRuntimeWarning]
    launcher_sha256: str
    def __init__(self, status: _Optional[_Union[AgentRuntimeHealthStatus, str]] = ..., runtime_engine: _Optional[str] = ..., runtime_version: _Optional[str] = ..., warnings: _Optional[_Iterable[_Union[AgentRuntimeWarning, _Mapping]]] = ..., launcher_sha256: _Optional[str] = ...) -> None: ...
