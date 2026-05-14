with open('admin.html', 'rb') as f:
    raw = f.read()

# Ã‚Â· = triple-encoded middle dot (·)
# U+00C3 U+201A U+00C2 U+00B7 → bytes: C383 E2809A C382 C2B7
pattern = bytes.fromhex('c383e2809ac382c2b7')
count = raw.count(pattern)
if count:
    raw = raw.replace(pattern, b'&middot;')
    print(f'Replaced {count}x  Ã‚Â· -> &middot;')
    with open('admin.html', 'wb') as f:
        f.write(raw)
    print('Saved.')
else:
    print(f'NOT FOUND: {pattern.hex()}')
    # Try partial
    for p in [b'\xc3\x83', b'\xc2\xb7', b'\xc3\x82\xc2\xb7']:
        idx = raw.find(p)
        if idx != -1:
            print(f'  partial {p.hex()} at {idx}: {raw[idx-2:idx+10].hex()}')
