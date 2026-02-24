#!/usr/bin/env python3
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode
from urllib.request import urlopen, Request
import json

PORT = 8123
BASES = ["https://api.polygon.io", "https://api.massive.com"]


def json_response(handler, status, payload):
    raw = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def fetch_massive(path, params):
    last_err = None
    query = urlencode(params)
    for base in BASES:
        url = f"{base}{path}?{query}"
        try:
            req = Request(url, headers={"Accept": "application/json"})
            with urlopen(req, timeout=25) as r:
                data = r.read().decode("utf-8", errors="replace")
                return json.loads(data)
        except Exception as e:
            last_err = str(e)
    raise RuntimeError(last_err or "Massive request failed")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return json_response(self, 200, {"ok": True})

        if parsed.path == "/api/etf/history":
            q = parse_qs(parsed.query)
            ticker = (q.get("ticker") or [""])[0].upper().strip()
            api_key = (q.get("apiKey") or [""])[0].strip()
            years = int((q.get("years") or ["3"])[0])
            if not ticker:
                return json_response(self, 400, {"error": "ticker missing"})
            if not api_key:
                return json_response(self, 400, {"error": "apiKey missing"})
            from datetime import datetime
            to = datetime.utcnow().date()
            frm = to.replace(year=to.year - years)
            try:
                data = fetch_massive(
                    f"/v2/aggs/ticker/{ticker}/range/1/day/{frm.isoformat()}/{to.isoformat()}",
                    {
                        "adjusted": "true",
                        "sort": "asc",
                        "limit": "50000",
                        "apiKey": api_key,
                    },
                )
                rows = data.get("results") or []
                mapped = [
                    {"date": __import__('datetime').datetime.utcfromtimestamp(r["t"] / 1000).date().isoformat(), "close": r.get("c")}
                    for r in rows
                    if isinstance(r, dict) and r.get("c") is not None and r.get("t")
                ]
                return json_response(self, 200, {"ticker": ticker, "results": mapped, "count": len(mapped)})
            except Exception as e:
                return json_response(self, 502, {"error": f"history failed: {e}"})

        if parsed.path == "/api/etf/snapshot":
            q = parse_qs(parsed.query)
            tickers = (q.get("tickers") or [""])[0].strip()
            api_key = (q.get("apiKey") or [""])[0].strip()
            if not tickers:
                return json_response(self, 400, {"error": "tickers missing"})
            if not api_key:
                return json_response(self, 400, {"error": "apiKey missing"})
            try:
                data = fetch_massive(
                    "/v2/snapshot/locale/us/markets/stocks/tickers",
                    {"tickers": tickers, "apiKey": api_key},
                )
                return json_response(self, 200, data)
            except Exception as e:
                return json_response(self, 502, {"error": f"snapshot failed: {e}"})

        return super().do_GET()


if __name__ == "__main__":
    print(f"Serving on http://0.0.0.0:{PORT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
