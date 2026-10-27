"""Talk to mihomo's REST API over the Windows named pipe that Clash Verge exposes.

Clash Verge sets `external-controller` to `\\.\pipe\...` rather than a TCP
port, so the normal http://127.0.0.1:9090 form does not exist. The pipe is a
plain duplex byte stream, so an HTTP/1.1 request can be written to it and the
response read back.
"""

import json
import sys
import urllib.request

PIPE = r'\\.\pipe\verge-mihomo-sidecar-release-6795b7079eb196f3816cb91d444d932d022e39d8d5cd8ec4d37f786698d285ef'
SECRET = 'set-your-secret'
HOST = 'github.com'


def request(method, path, body=None):
    """Send one HTTP request over the pipe and return (status, parsed_json)."""
    payload = b'' if body is None else json.dumps(body).encode()
    head = (
        f'{method} {path} HTTP/1.1\r\n'
        f'Host: {HOST}\r\n'
        f'Authorization: Bearer {SECRET}\r\n'
        f'Content-Type: application/json\r\n'
        f'Content-Length: {len(payload)}\r\n'
        f'Connection: close\r\n\r\n'
    ).encode()

    with open(PIPE, 'r+b', buffering=0) as pipe:
        pipe.write(head + payload)
        # The server closes the connection when it is done with the response.
        chunks = []
        while True:
            try:
                chunk = pipe.read(65536)
            except OSError:
                break
            if not chunk:
                break
            chunks.append(chunk)
    raw = b''.join(chunks)
    if not raw:
        return 0, None
    header, _, tail = raw.partition(b'\r\n\r\n')
    status = int(header.split(b' ')[1]) if header.split(b' ') else 0
    try:
        return status, json.loads(tail.decode('utf-8', 'replace'))
    except json.JSONDecodeError:
        return status, tail.decode('utf-8', 'replace')


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else 'list'
    if action == 'list':
        status, data = request('GET', '/proxies/%E9%9B%B7%E4%BA%91X')
        if isinstance(data, dict):
            print('当前节点:', data.get('now'))
            print('可选:')
            for name in data.get('all', []):
                print(' -', name)
        else:
            print('状态', status, repr(data)[:400])
    elif action == 'set':
        name = sys.argv[2]
        status, data = request('PUT', '/proxies/%E9%9B%B7%E4%BA%91X', {'name': name})
        print('切换 ->', name, '状态', status, repr(data)[:200])
    elif action == 'test':
        # Switch to a node, then report what the outside world sees.
        name = sys.argv[2]
        request('PUT', '/proxies/%E9%9B%B7%E4%BA%91X', {'name': name})
        status, data = request('GET', '/proxies/%E9%9B%B7%E4%BA%91X')
        print('现在:', data.get('now') if isinstance(data, dict) else data)


if __name__ == '__main__':
    main()
