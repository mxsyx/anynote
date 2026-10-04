import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
const root = resolve("."),
  tmp = mkdtempSync("/tmp/anynote-sdk-consumer-");
try {
  execFileSync(process.execPath, ["scripts/build-sdk.mjs"], { cwd: root });
  const packed = JSON.parse(
    execFileSync(
      "pnpm",
      [
        "--config.ignoreScripts=true",
        "--dir",
        "./artifacts/plugin-sdk",
        "pack",
        "--pack-destination",
        tmp,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.ok(
    packed.files.every(
      (f) =>
        !f.path.includes("host") &&
        !f.path.includes("storage") &&
        !/script-(runner|worker|state)/.test(f.path),
    ),
  );
  writeFileSync(
    join(tmp, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    "pnpm",
    ["add", "--offline", "--ignore-scripts", packed.filename],
    { cwd: tmp },
  );
  assert.ok(
    existsSync(
      join(
        tmp,
        "node_modules/@anynote/plugin-sdk/examples/reading-callout.json",
      ),
    ),
  );
  assert.ok(
    existsSync(
      join(
        tmp,
        "node_modules/@anynote/plugin-sdk/examples/reading-session.json",
      ),
    ),
  );
  assert.ok(
    existsSync(
      join(
        tmp,
        "node_modules/@anynote/plugin-sdk/examples/reading-preferences.json",
      ),
    ),
  );
  for (const name of [
    "reading-session-v2",
    "reading-preferences-v2",
    "reading-related",
    "reading-async-related",
    "reading-network",
  ])
    assert.ok(
      existsSync(
        join(tmp, `node_modules/@anynote/plugin-sdk/examples/${name}.json`),
      ),
    );
  writeFileSync(
    join(tmp, "consumer.ts"),
    `import {createAPI, sdkVersion, CommandRegistry, type DeclarativeManifest, type ExtensionContext, type ScriptManifest, type SignedExtensionPackage, type ExtensionSource, type ExtensionDirectory, type SavedExtensionDirectory, type StatefulMarkdownTransformInput, type StatefulMarkdownTransformResult, type ExtensionSettingsContribution, type ExtensionSettingsSnapshot, type ExtensionDataMigration, type ExtensionDataReview, type ExtensionDataOverview, type ExtensionDataApplyResult, type ScriptSearchRequest, type ScriptSearchContext, type ScriptAsyncSearchRequest, type ScriptHostAPI, type ScriptNetworkAPI, type ScriptNetworkRequest, type ScriptNetworkResult} from '@anynote/plugin-sdk';
const manifest: DeclarativeManifest = {id:'garden.test',name:'Test',version:'0.1.0',engines:{anynote:'^0.1.0'},runtime:'declarative',permissions:['notes:write'],contributes:{commands:[],editorNodes:[]}};
const context: ExtensionContext | undefined = undefined;
const script:ScriptManifest={id:'garden.script',name:'Script',version:'0.1.0',engines:{anynote:'^0.1.0'},runtime:'quickjs-transform',permissions:['notes:read','notes:write'],contributes:{commands:[{id:'garden.script.command',title:'Transform',action:{kind:'transformMarkdown',script:'(note)=>note.body'}}],editorNodes:[]}};
const searchRequest:ScriptSearchRequest={query:'reading',limit:5};
const searchContext:ScriptSearchContext={query:'reading',truncated:false,results:[{id:'id',title:'Reading',revision:1,noteType:'markdown',snippet:'text'}]};
const withSearch:ScriptManifest={...script,permissions:['notes:read','notes:write','search:read'],contributes:{commands:[{id:'garden.script.search',title:'Search',action:{kind:'transformMarkdown',script:'(n)=>n.body',searchContext:searchRequest}}],editorNodes:[]}};
void searchContext;void withSearch;
const asyncRequest:ScriptAsyncSearchRequest={id:'reading',query:'reading',limit:5};
const withAsync:ScriptManifest={...script,permissions:['notes:read','notes:write','search:read'],contributes:{commands:[{id:'garden.script.async',title:'Async',action:{kind:'transformMarkdown',script:'async(n,h)=>{await h.search("reading");return n.body;}',asyncSearch:[asyncRequest]}}],editorNodes:[]}};
const guest=async(host:ScriptHostAPI)=>(await host.search('reading')).results;
void withAsync;void guest;
const networkRequest:ScriptNetworkRequest={id:'reference',url:'https://example.com/reference.txt'};
const networkResult:ScriptNetworkResult={url:networkRequest.url,mime:'text/plain',text:'Reference'};
const withNetwork:ScriptManifest={...script,permissions:['notes:read','notes:write','network'],contributes:{commands:[{id:'garden.script.network',title:'Network',action:{kind:'transformMarkdown',script:'async(n,h)=>{await h.request("reference");return n.body;}',networkRequests:[networkRequest]}}],editorNodes:[]}};
const networkGuest=async(host:ScriptNetworkAPI)=>(await host.request('reference')).text;
void networkResult;void withNetwork;void networkGuest;
const form:ExtensionSettingsContribution={version:1,fields:[{key:'title',label:'Title',kind:'text',default:'Note'},{key:'limit',label:'Limit',kind:'number',default:3,min:1,max:10,integer:true},{key:'enabled',label:'Enabled',kind:'boolean',default:true}]};
const preferences:ExtensionSettingsSnapshot={revision:1,compatible:true,values:{title:'Note',limit:3,enabled:true}};
const configurable:ScriptManifest={...script,permissions:['notes:read','notes:write','settings:read','settings:write'],contributes:{...script.contributes,settings:form}};
const migration:ExtensionDataMigration={id:'garden.script.v2',title:'Upgrade',target:'scriptState',fromVersion:1,toVersion:2,rename:{runs:'visits'},defaults:{extra:true}};
const v2:ScriptManifest={...configurable,contributes:{...configurable.contributes,stateVersion:2,dataMigrations:[migration],commands:[{id:'garden.script.state',title:'State',action:{kind:'transformMarkdownWithState',script:'(n)=>({body:n.body,state:n.state})'}}]}};
const dataReview:ExtensionDataReview={reviewId:'id',mode:'migration',target:'scriptState',title:'Upgrade',before:'{}',after:'{}',fromVersion:1,toVersion:2,expiresAt:0};
const overview:ExtensionDataOverview={targets:[],backups:[]};const applied:ExtensionDataApplyResult={backupId:'id',revision:2};
void preferences;void configurable;void migration;void v2;void dataReview;void overview;void applied;
const stateInput:StatefulMarkdownTransformInput={id:'note',title:'Note',body:'Body',revision:1,state:{runs:1,nested:[true,null,'x']}};
const stateOutput:StatefulMarkdownTransformResult={body:stateInput.body,state:{runs:2}};
const stateCommand:ScriptManifest={...script,permissions:['notes:read','notes:write','settings:read','settings:write'],contributes:{commands:[{id:'garden.script.state',title:'State',action:{kind:'transformMarkdownWithState',script:'(n)=>({body:n.body,state:n.state})'}}],editorNodes:[]}};
void stateInput;void stateOutput;void stateCommand;
const source:ExtensionSource={signed:true,trusted:false,fingerprint:'0'.repeat(64),publisher:'Test'};
const signed:SignedExtensionPackage={format:'anynote.extension.v1',algorithm:'Ed25519',publisher:'Test',publicKey:'public',manifest:script,signature:'signature'};
const directory:ExtensionDirectory={format:'anynote.extension-directory.v1',name:'Examples',entries:[{id:script.id,name:script.name,version:script.version,runtime:script.runtime,permissions:script.permissions,url:'https://example.com/script.json',checksum:'0'.repeat(64),fingerprint:'0'.repeat(64)}]};
const saved:SavedExtensionDirectory={id:'directory-id',name:'Examples',url:'https://example.com/extensions.json'};
void manifest; void context; void script; void source; void signed; void directory; void saved;
const api=createAPI(async(method,input)=>({method,input}));
const result=await api.notes.get('note');
if((result as unknown as {method:string}).method!=='notes.get'||sdkVersion!=='0.1.0') throw Error('SDK transport failed');
const registry=new CommandRegistry();const old=registry.register('test',()=>1);old();const next=registry.register('test',()=>2);old();if(await registry.execute('test')!==2)throw Error('stale disposer');next();
`,
  );
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "consumer.ts",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2022,DOM",
    ],
    { cwd: tmp },
  );
  execFileSync(process.execPath, ["consumer.js"], { cwd: tmp });
  console.log("SDK tarball: clean offline consumer types and runtime passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
