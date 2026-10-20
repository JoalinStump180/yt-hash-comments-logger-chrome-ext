python3 << 'PY'
from pathlib import Path
p = Path("/workspace/artifacts/curr-20261019-ai-commentlog-2tab/explorer.js")
s = p.read_text()
old = '''          if (have.has(r.id)) return false;
          const url = String(r.url || "");
          const id = pageIdOf(url);
          return hitUrls.some((u) => (url && u.includes(url)) || (id && id.length >= 6 && u.includes(id)));'''
new = '''          if (have.has(r.id)) return false;
          const url = String(r.url || "");
          const id = pageIdOf(url);
          if (!id) return false;
          return hitUrls.some((u) => (url && u.includes(url)) || (id.length >= 6 && u.includes(id)));'''
if old not in s:
    raise SystemExit('block missing')
p.write_text(s.replace(old, new, 1))
print('added')
PYadded