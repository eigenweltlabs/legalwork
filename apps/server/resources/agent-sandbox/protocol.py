"""Bounded binary file chunks, with JSON for control and network approvals."""
import json
import struct
import sys
import threading

MAX_FRAME = 24 * 1024 * 1024
MAX_BINARY = 128 * 1024
OUT = threading.Lock()


def slot(message, kind):
    inner = message.get('payload', message)
    if kind == 'write' and inner.get('event') == 'filesystem' and inner['request']['op'] == 'write':
        return inner['request'], 'data'
    if kind == 'read' and isinstance(inner.get('id'), str) and isinstance(inner.get('response'), dict):
        return inner['response'], 'result'
    raise ValueError('Invalid binary attachment')


def encode_frame(message):
    message = dict(message)
    if 'payload' in message:
        message['payload'] = dict(message['payload'])
    inner = message.get('payload', message)
    kind, binary = None, b''
    if inner.get('event') == 'filesystem' and inner['request']['op'] == 'write':
        inner['request'] = dict(inner['request'])
        kind = 'write'
    elif isinstance(inner.get('response'), dict) and isinstance(inner['response'].get('result'), bytes):
        inner['response'] = dict(inner['response'])
        kind = 'read'
    if kind:
        parent, key = slot(message, kind)
        binary = parent[key]
        if not isinstance(binary, bytes) or len(binary) > MAX_BINARY:
            raise ValueError('Invalid binary chunk')
        parent[key] = None
    frame = {'message': message}
    if kind:
        frame['binary'] = kind
    header = json.dumps(frame, separators=(',', ':')).encode()
    if len(header) > MAX_FRAME:
        raise ValueError('Frame too large')
    return struct.pack('!II', len(header), len(binary)) + header + binary


def write_frame(message, stream):
    remaining = memoryview(encode_frame(message))
    while remaining:
        written = stream.write(remaining)
        if not written:
            raise OSError('Host channel closed during write')
        remaining = remaining[written:]
    stream.flush()


def emit(message):
    with OUT:
        write_frame(message, sys.stdout.buffer)


def read_exact(stream, size):
    parts = []
    while size:
        part = stream.read(size)
        if not part:
            raise EOFError('Truncated sandbox frame')
        parts.append(part)
        size -= len(part)
    return b''.join(parts)


def read_frame(stream=None, allow_eof=False):
    stream = sys.stdin.buffer if stream is None else stream
    first = stream.read(1)
    if not first and allow_eof:
        return None
    if not first:
        raise EOFError('Host channel closed')
    json_length, binary_length = struct.unpack('!II', first + read_exact(stream, 7))
    if not 0 < json_length <= MAX_FRAME or binary_length > MAX_BINARY:
        raise ValueError('Frame too large')
    frame = json.loads(read_exact(stream, json_length))
    message = frame['message']
    if 'binary' in frame:
        parent, key = slot(message, frame['binary'])
        if parent[key] is not None:
            raise ValueError('Ambiguous binary attachment')
        parent[key] = read_exact(stream, binary_length)
    elif binary_length:
        raise ValueError('Unexpected binary attachment')
    return message
