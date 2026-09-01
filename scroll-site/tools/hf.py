#!/usr/bin/env python3
"""
Higgsfield pipeline client for the coffee-scroll project.

Usage:
  python3 hf.py image '<json>'    # {"name": str, "prompt": str, "model": str?, "out": path?}
  python3 hf.py upload <file>
  python3 hf.py video '<json>'    # {"name": str, "image_url": str, "prompt": str,
                                  #  "negative_prompt": str?, "duration": int?, "model": str?,
                                  #  "end_image_url": str?, "out": path?}

Reads HF_KEY ('key:secret') from env or from .env next to the project root.
"""

import sys
import os
import json
import time
import requests

BASE_URL = "https://platform.higgsfield.ai"
PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

KLING_MODELS = {"kling-video/v2.1/pro/image-to-video", "kling-video/v2.1/standard/image-to-video"}
WAN_MODELS = {"wan-25-preview/image-to-video"}
HF_KEY_MODELS = KLING_MODELS | WAN_MODELS


def get_key_secret():
    hf_key = os.environ.get("HF_KEY", "")
    if not hf_key:
        env_path = os.path.join(PROJECT, ".env")
        if os.path.exists(env_path):
            for line in open(env_path):
                if line.startswith("HF_KEY="):
                    hf_key = line.split("=", 1)[1].strip().strip("'\"")
    if ":" in hf_key:
        key, secret = hf_key.split(":", 1)
        return key.strip(), secret.strip()
    print("ERROR: HF_KEY not found (env or .env)")
    sys.exit(1)


def auth_headers():
    key, secret = get_key_secret()
    return {
        "Authorization": f"Key {key}:{secret}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def video_headers(model):
    key, secret = get_key_secret()
    base = {"Content-Type": "application/json", "Accept": "application/json"}
    if model in HF_KEY_MODELS:
        return {**base, "hf-api-key": key, "hf-secret": secret}
    return {**base, "Authorization": f"Key {key}:{secret}"}


def poll_headers():
    key, secret = get_key_secret()
    return {"Authorization": f"Key {key}:{secret}", "hf-api-key": key, "hf-secret": secret}


def download(url, out_path):
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "wb") as f:
        f.write(r.content)
    print(f"saved: {out_path}")


def poll(request_id, timeout=600, interval=6, kind="image"):
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(f"{BASE_URL}/requests/{request_id}/status", headers=poll_headers(), timeout=15)
            if r.ok:
                d = r.json()
                status = d.get("status", "")
                if status == "completed":
                    if kind == "image":
                        images = d.get("images", [])
                        if images:
                            return images[0].get("url")
                        return (d.get("image") or {}).get("url")
                    video = d.get("video") or {}
                    url = video.get("url") if isinstance(video, dict) else None
                    if not url:
                        r2 = requests.get(f"{BASE_URL}/requests/{request_id}/result", headers=poll_headers(), timeout=15)
                        if r2.ok:
                            v = r2.json().get("video") or {}
                            url = v.get("url") if isinstance(v, dict) else None
                    return url
                if status in ("failed", "nsfw", "cancelled"):
                    print(f"  {status}: {d.get('error', '')}")
                    return None
                print(f"  [{kind}] {status} ({int(time.time() - start)}s)...")
        except requests.RequestException as e:
            print(f"  [{kind}] network error: {e}")
        time.sleep(interval)
    print(f"  [{kind}] timed out")
    return None


def gen_image(spec):
    model = spec.get("model", "higgsfield-ai/soul/standard")
    payload = {"prompt": spec["prompt"], "aspect_ratio": spec.get("aspect_ratio", "16:9")}
    print(f"[image] {spec['name']} → {model}")
    resp = requests.post(f"{BASE_URL}/{model}", headers=auth_headers(), json=payload, timeout=30)
    print(f"[image] submit → {resp.status_code}")
    if not resp.ok:
        print(f"FAILED: {resp.text[:300]}")
        return None
    data = resp.json()
    url = None
    if data.get("images"):
        url = data["images"][0].get("url")
    else:
        request_id = data.get("request_id")
        if not request_id:
            print(f"no request_id: {data}")
            return None
        url = poll(request_id, kind="image")
    if url:
        out = spec.get("out") or os.path.join(PROJECT, "assets", f"{spec['name']}.png")
        download(url, out)
        print(f"URL: {url}")
    return url


def upload_image(file_path):
    key, secret = get_key_secret()
    os.environ["HF_KEY"] = f"{key}:{secret}"
    import higgsfield_client
    url = higgsfield_client.upload_file(file_path)
    print(f"UPLOADED: {url}")
    return url


def gen_video(spec):
    model = spec.get("model", "kling-video/v2.1/pro/image-to-video")
    payload = {
        "image_url": spec["image_url"],
        "prompt": spec["prompt"],
        "duration": spec.get("duration", 5),
    }
    if spec.get("negative_prompt"):
        payload["negative_prompt"] = spec["negative_prompt"]
    if model in KLING_MODELS:
        payload["cfg_scale"] = spec.get("cfg_scale", 0.5)
        # end-frame conditioning: try the tail-image param if provided
        if spec.get("end_image_url"):
            payload["image_tail_url"] = spec["end_image_url"]
    if model in WAN_MODELS:
        payload["resolution"] = spec.get("resolution", "720p")
        payload["seed"] = spec.get("seed", -1)
    print(f"[video] {spec['name']} → {model}")
    resp = requests.post(f"{BASE_URL}/{model}", headers=video_headers(model), json=payload, timeout=30)
    print(f"[video] submit → {resp.status_code}")
    if not resp.ok:
        print(f"FAILED: {resp.text[:300]}")
        return None
    data = resp.json()
    request_id = data.get("request_id")
    if not request_id:
        print(f"no request_id: {data}")
        return None
    print(f"[video] queued: {request_id}")
    url = poll(request_id, timeout=900, kind="video")
    if url:
        out = spec.get("out") or os.path.join(PROJECT, "assets", "clips", f"{spec['name']}.mp4")
        download(url, out)
        print(f"URL: {url}")
    return url


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "image":
        gen_image(json.loads(sys.argv[2]))
    elif cmd == "upload":
        upload_image(sys.argv[2])
    elif cmd == "video":
        gen_video(json.loads(sys.argv[2]))
    else:
        print(f"unknown command {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
