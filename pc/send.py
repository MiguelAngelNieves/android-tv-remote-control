#!/usr/bin/env python3
"""Envía un enlace (o un comando) a la TV desde el PC.

Uso:
  python send.py https://youtube.com/watch?v=...        # abrir enlace
  python send.py --cmd toggle                           # play/pausa
  python send.py --cmd seek --value 60                  # adelantar 60 s
  python send.py --cmd home                             # volver al inicio

Variables de entorno: TV_SERVER (ej. https://tv.midominio.com), TV_TOKEN
"""
import argparse, json, os, sys, urllib.request

SERVER = os.environ.get("TV_SERVER", "http://localhost:8080").rstrip("/")
TOKEN = os.environ.get("TV_TOKEN", "")

def post(path, body):
    req = urllib.request.Request(
        SERVER + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

ap = argparse.ArgumentParser()
ap.add_argument("url", nargs="?")
ap.add_argument("--cmd")
ap.add_argument("--value", type=float, default=0)
a = ap.parse_args()

if a.url:
    print(post("/api/open", {"url": a.url}))
elif a.cmd in ("back", "forward", "reload", "home"):
    print(post("/api/cmd", {"type": "nav", "action": a.cmd}))
elif a.cmd in ("toggle", "play", "pause", "seek", "seekto", "speed", "mute", "fullscreen"):
    print(post("/api/cmd", {"type": "media", "action": a.cmd, "value": a.value}))
else:
    ap.print_help(); sys.exit(1)
