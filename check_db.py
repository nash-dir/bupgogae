import gzip
import json

paths = {
    '260413': r'c:\projects\bupgogae\report\db.json-260413.gz',
    '260414': r'c:\projects\bupgogae\report\db.json-260414.gz'
}

for name, path in paths.items():
    print(f'\n--- {name} ---')
    data = None
    try:
        with gzip.open(path, 'rt', encoding='utf-8') as f:
            data = json.load(f)
        print('Compression: GZIP')
    except Exception:
        with open(path, 'rt', encoding='utf-8') as f:
            data = json.load(f)
        print('Compression: NONE (Plain Text JSON)')
        
    if data:
        print(f'Total key value: {data.get("total")}')
        cases = data.get('cases', {})
        print(f'Actual cases count: {len(cases)}')
