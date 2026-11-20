"""Publish a complete candidate first, then atomically move both update pointers."""
import argparse,base64,json,os,pathlib,subprocess,tempfile,urllib.request,urllib.error,urllib.parse

def main():
    p=argparse.ArgumentParser();p.add_argument('--assets',required=True);p.add_argument('--feed',required=True);p.add_argument('--version',required=True);p.add_argument('--commit',required=True);p.add_argument('--approve-stable',action='store_true');a=p.parse_args()
    repo=os.environ['GITHUB_REPOSITORY'];token=os.environ.get('GH_TOKEN') or os.environ['GITHUB_TOKEN'];tag='v'+a.version
    preview='-' in a.version;channel='preview' if preview else 'latest'
    if not preview and not a.approve_stable:raise RuntimeError('Stable publication requires separate owner approval')
    def api(path,data=None,method=None):
        request=urllib.request.Request('https://api.github.com/repos/'+repo+'/'+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=60) as response:return json.load(response)
    def optional(path):
        try:return api(path)
        except urllib.error.HTTPError as e:
            if e.code==404:return None
            raise
    assets=pathlib.Path(a.assets);feed=pathlib.Path(a.feed)
    release=optional('releases/tags/'+urllib.parse.quote(tag,safe=''))
    if release and release['target_commitish']!=a.commit:raise RuntimeError('Draft belongs to a different source revision')
    published=bool(release and not release['draft'])
    if not release:
        subprocess.run(['gh','release','create',tag,'--repo',repo,'--target',a.commit,'--draft',*(['--prerelease'] if preview else []),'--title','home_theater '+a.version,'--notes','Windows; Linux/Arch — preview. Обновление проверяется до подключения к серверу. Первый переход со старых сборок требует установки этого пакета.'],check=True)
    files=sorted(str(f) for f in assets.iterdir() if f.is_file() and (f.suffix in ('.exe','.AppImage','.blockmap','.yml') and not f.name.startswith('builder-') or f.name in ('SHA256SUMS.txt','release.json')))
    if published:
        # A network failure after release publication must permit repairing only the pointer.
        remote=next((x for x in release['assets'] if x['name']=='SHA256SUMS.txt'),None)
        if not remote:raise RuntimeError('Published release has no verifiable checksum manifest')
        with urllib.request.urlopen(remote['browser_download_url'],timeout=60) as response:
            if response.read()!=(assets/'SHA256SUMS.txt').read_bytes():raise RuntimeError('Published releases are immutable; create a new version')
        uploaded={x['name']:x['size'] for x in release['assets']}
        if any(uploaded.get(pathlib.Path(f).name)!=pathlib.Path(f).stat().st_size for f in files):raise RuntimeError('Published assets differ from the verified build')
    else:
        subprocess.run(['gh','release','upload',tag,'--repo',repo,'--clobber',*files],check=True)
        subprocess.run(['gh','release','edit',tag,'--repo',repo,'--draft=false','--prerelease='+str(preview).lower()],check=True)
    ref=optional('git/ref/heads/desktop-updates');parent=ref['object']['sha'] if ref else None
    old=optional('contents/'+channel+'.yml?ref=desktop-updates') if ref else None
    if old:
        text=base64.b64decode(old['content']).decode();previous=next(line.split(':',1)[1].strip().strip("'\"") for line in text.splitlines() if line.startswith('version:'))
        result=subprocess.run(['node','scripts/ci/desktop-release.mjs','newer',a.version,previous])
        if result.returncode==3:print('Published candidate; newer preview pointer retained');return
        result.check_returncode()
    entries=[{'path':name,'mode':'100644','type':'blob','content':(feed/name).read_text(encoding='utf-8')} for name in (channel+'.yml',channel+'-linux.yml')]
    if not preview:
        old_preview=optional('contents/preview.yml?ref=desktop-updates') if ref else None
        promote=True
        if old_preview:
            text=base64.b64decode(old_preview['content']).decode();previous_preview=next(line.split(':',1)[1].strip().strip("'\"") for line in text.splitlines() if line.startswith('version:'))
            result=subprocess.run(['node','scripts/ci/desktop-release.mjs','newer',a.version,previous_preview])
            if result.returncode==3:promote=False
            else:result.check_returncode()
        if promote:
            entries.extend({'path':name,'mode':'100644','type':'blob','content':(feed/name).read_text(encoding='utf-8')} for name in ('preview.yml','preview-linux.yml'))
    tree_args={'tree':entries}
    if parent:tree_args['base_tree']=api('git/commits/'+parent)['tree']['sha']
    else:entries.append({'path':'README.md','mode':'100644','type':'blob','content':'# Desktop update feed\n\nАвтоматические указатели stable/preview. Установщики и контрольные суммы хранятся в версионных GitHub Releases. Оба платформенных указателя обновляются одним коммитом после публикации полного выпуска.\n'})
    tree=api('git/trees',tree_args)['sha'];commit=api('git/commits',{'message':'desktop '+channel+' '+a.version,'tree':tree,'parents':[parent] if parent else []})['sha']
    if ref:api('git/refs/heads/desktop-updates',{'sha':commit,'force':False},'PATCH')
    else:api('git/refs',{'ref':'refs/heads/desktop-updates','sha':commit})
    print(json.dumps({'version':a.version,'releasePublished':True,'feedUpdatedAtomically':True,'feedCommit':commit}))

if __name__=='__main__':main()
