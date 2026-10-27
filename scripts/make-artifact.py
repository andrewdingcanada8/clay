# Turn dist-single/index.html into a page body for publishing as a claude.ai
# Artifact (the host supplies doctype, charset and viewport meta).
import re, sys
src = open('dist-single/index.html', encoding='utf-8').read()
head = re.search(r'<head>(.*?)</head>', src, re.S).group(1)
body = re.search(r'<body>(.*)</body>', src, re.S).group(1)
head = re.sub(r'<meta charset[^>]*>', '', head)
head = re.sub(r'<meta name="viewport"[^>]*>', '', head)
out = sys.argv[1] if len(sys.argv) > 1 else 'dist-single/artifact.html'
open(out, 'w', encoding='utf-8').write(head.strip() + '\n' + body.strip() + '\n')
print(out)
