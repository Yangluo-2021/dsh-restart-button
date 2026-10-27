"""Find a Clash node whose exit IP passes Cloudflare on www.npmjs.com.

Traffic goes through the Clash mixed port explicitly (127.0.0.1:7897) so the
node actually gets exercised — relying on the system proxy makes every node
look identical. The original node is restored at the end.
"""

import subprocess
import sys

sys.path.insert(0, r'C:\Users\99687\Desktop\DSH插件发布\.workbuddy\tools')
from clash_pipe import request  # noqa: E402

GROUP = '/proxies/%E9%9B%B7%E4%BA%91X'
PROXY = 'http://127.0.0.1:7897'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')


def curl(url, extra=None):
    cmd = ['curl', '-s', '-x', PROXY, '--max-time', '25', '-A', UA, url]
    if extra:
        cmd[1:1] = extra
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    return out


def main():
    status, data = request('GET', GROUP)
    original = data.get('now')
    nodes = [n for n in data.get('all', []) if n not in ('自动选择', '故障转移')]
    print(f'原节点: {original}    待测: {len(nodes)}\n')

    winners = []
    for node in nodes:
        request('PUT', GROUP, {'name': node})
        ip = curl('https://api.ipify.org?format=json').strip()[:45]
        body = curl('https://www.npmjs.com/login')
        challenged = 'Just a moment' in body or '_cf_chl_' in body
        if body.startswith('{'):
            code = 'JSON'
        else:
            code = '挑战' if challenged else '有内容'
        print(f'{node:<22} exit={ip:<42} npmjs={code}')
        if not challenged and len(body) > 2000:
            winners.append((node, ip))

    request('PUT', GROUP, {'name': original})
    print('\n已还原:', original)
    print('通过挑战的节点:', winners if winners else '（无）')


if __name__ == '__main__':
    main()
