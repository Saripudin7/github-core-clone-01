// github-core-clone-01 entry: a standalone, GitHub-compatible git forge in one process.
//
// Serves, from its own in-memory store, with the Node 22 standard library only:
//   - git smart HTTP: upload-pack protocol v2 (ls-refs, fetch, shallow), receive-pack v0
//   - REST v3 under /api/v3: repositories, branches, commits, contents, issues, labels, pulls
//   - GraphQL v4 at /api/graphql: the documents gh and github-mcp-server send
//   - MCP at /mcp: streamable HTTP, revision 2026-07-28 (server/discover) + legacy initialize
//
// Lifecycle (wire.ts): bind an ephemeral port, POST {"port"} to $MAKEFUN_ENV_URL/register,
// poll GET $MAKEFUN_ENV_URL/done until {"done":true}, exit 0.
//
// The viewer login is the scenario's fixed viewer (kit sdk/conformance/wire.ts buildScenario()
// derives it from the one constant SCENARIO_SEED; users[0] is always adaiversen). The suite's
// bearer token is MAKEFUN_SHOP_TOKEN; a request without the exact token is 401 on the API
// surfaces. No wall clock reaches any stored value: commit timestamps and dates come from a
// deterministic counter, so two runs on the same instance behave identically.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// --------------------------------------------------------------------------- constants

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0'.repeat(40);
const DEFAULT_BRANCH = 'main';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const VERSION = '1.0.0';

// Deterministic clock: every timestamp the forge mints comes from this counter, never Date.now().
let tsSeq = 0;
function nextTs(): number {
  tsSeq += 1;
  return 1700000000 + tsSeq;
}
function isoOf(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

// --------------------------------------------------------------------------- git object model

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const HEX40 = /^[0-9a-f]{40}$/;

function isOid(value: string): boolean {
  return HEX40.test(value);
}

function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function buildCommit(fields: { tree: string; parents: string[]; message: string; timestamp: number }): Buffer {
  const who = `${IDENTITY} ${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

function buildTag(fields: { object: string; type: ObjType; tag: string; message: string; timestamp: number }): Buffer {
  const tagger = `${IDENTITY} ${fields.timestamp} +0000`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target).
 * Commits in `stopAt` contribute their tree but not their parents: a client that holds a
 * commit as a shallow boundary does not have its ancestors. */
function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  stopAt: Set<string> = new Set<string>(),
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!stopAt.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// --------------------------------------------------------------------------- packfiles (plain objects, no deltas)

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

/** Read a packfile of plain objects (the client only ever sends those). Returns oid -> object. */
function readPack(pack: Buffer): Map<string, GitObject> {
  const objects = new Map<string, GitObject>();
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    const oid = hashObject(type, inflated.buffer);
    objects.set(oid, { type, data: inflated.buffer });
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');
  return objects;
}

// --------------------------------------------------------------------------- pkt-line codec

const PKT_MAX = 65520;

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload?: Buffer;
}

/** Decode a whole buffer of pkt-lines; `rest` is the bytes after the first flush packet. */
function decodePktLines(bytes: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX || offset + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

/** Split one band-1 sideband payload into pkt-lines (report-status inside band 1). */
function decodeSidebandReport(bytes: Buffer): string[] {
  const { packets } = decodePktLines(bytes);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== undefined) lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

/** Wrap `data` in sideband band-1 packets (<= 65515 bytes of data each). */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// --------------------------------------------------------------------------- store

interface Label {
  name: string;
  color: string;
  description: string;
}
interface Comment {
  id: number;
  body: string;
  user: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}
interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  baseSha: string;
  files: PullFile[];
  seq: number;
}
interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  labels: Map<string, Label>;
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextPullId = 1;
let repoSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  repoSeq += 1;
  const repo: Repo = {
    dbId: nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    seq: repoSeq,
    objects: new Map(),
    refs: new Map(),
    issues: [],
    labels: new Map(),
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  // Store the message byte-exact: the suite compares GET /commits[].commit.message with the
  // exact string it sent to PUT /contents, and the kit's own buildCommit adds no newline.
  return storeObject(repo, 'commit', buildCommit({ tree, parents, message, timestamp: nextTs() }));
}

// --------------------------------------------------------------------------- trees

/** Flatten a tree into path -> {oid, mode}, recursively. */
function flattenTree(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  if (treeOid === null) return;
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** Build nested tree objects from a flat path map; stores objects; returns the root tree oid. */
function buildTreeFromMap(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of [...flat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of [...node.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: value.mode, name, oid: value.oid });
    }
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Diff two trees (null = empty): the changed files, base -> head. */
function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, baseTree, '', base);
  flattenTree(repo, headTree, '', head);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined) {
      if (b.oid === h.oid) continue;
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(newData);
      const deletions = countLines(oldData);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    } else if (h !== undefined) {
      const newData = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(newData);
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b !== undefined) {
      const oldData = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(oldData);
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    }
  }
  return files;
}

function refTip(repo: Repo, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function treeOfCommit(repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Resolve a ref argument (branch name, or a 40-hex commit id) to a commit oid. */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  const asBranch = branchTip(repo, ref);
  if (asBranch !== null) return asBranch;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// --------------------------------------------------------------------------- contents commits

interface ContentWrite {
  commitSha: string;
  blobSha: string;
  created: boolean;
}

/** Write (or replace) a file on a branch, creating the branch from the default tip when needed. */
function writeContentFile(
  repo: Repo,
  branch: string | undefined,
  path: string,
  content: Buffer,
  message: string,
): ContentWrite {
  const branchName = branch ?? repo.defaultBranch;
  let tip = branchTip(repo, branchName);
  if (tip === null && branchName !== repo.defaultBranch) {
    tip = branchTip(repo, repo.defaultBranch);
    if (tip !== null) repo.refs.set(`refs/heads/${branchName}`, tip);
  }
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOfCommit(repo, tip), '', flat);
  const created = !flat.has(path);
  const blobSha = storeObject(repo, 'blob', content);
  flat.set(path, { oid: blobSha, mode: '100644' });
  const tree = buildTreeFromMap(repo, flat);
  const commitSha = makeCommit(repo, tree, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  return { commitSha, blobSha, created };
}

function deleteContentFile(repo: Repo, branch: string | undefined, path: string, message: string): { commitSha: string } | null {
  const branchName = branch ?? repo.defaultBranch;
  const tip = branchTip(repo, branchName);
  if (tip === null) return null;
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOfCommit(repo, tip), '', flat);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const tree = buildTreeFromMap(repo, flat);
  const commitSha = makeCommit(repo, tree, [tip], message);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  return { commitSha };
}

/** Read one file's blob at a commit. */
function readFileAt(repo: Repo, commitOid: string | null, path: string): { oid: string; data: Buffer } | null {
  if (commitOid === null) return null;
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOfCommit(repo, commitOid), '', flat);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const object = repo.objects.get(entry.oid);
  if (!object) return null;
  return { oid: entry.oid, data: object.data };
}

/** List a directory at a commit: entries under `dir` ('' = root). */
function listDirAt(
  repo: Repo,
  commitOid: string | null,
  dir: string,
): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | null {
  if (commitOid === null) return null;
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, treeOfCommit(repo, commitOid), '', flat);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { name: string; path: string; sha: string; type: 'file' | 'dir' }>();
  for (const [path, value] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { name: rest, path, sha: value.oid, type: 'file' });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        // The directory's own tree oid, for the sha field.
        let dirOid = '';
        const walk = (treeOid: string | null, segments: string[]): void => {
          if (treeOid === null || segments.length === 0) return;
          const object = repo.objects.get(treeOid);
          if (!object || object.type !== 'tree') return;
          for (const entry of parseTree(object.data)) {
            if (entry.name === segments[0]) {
              if (segments.length === 1) dirOid = entry.oid;
              else walk(entry.oid, segments.slice(1));
            }
          }
        };
        walk(treeOfCommit(repo, commitOid), `${prefix}${name}`.split('/'));
        seen.set(name, { name, path: `${prefix}${name}`, sha: dirOid, type: 'dir' });
      }
    }
  }
  if (seen.size === 0 && dir !== '') {
    // A missing directory is a 404, not an empty listing.
    const anyUnder = [...flat.keys()].some((path) => path.startsWith(prefix));
    if (!anyUnder) return null;
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Commits reachable from a ref, newest first (by creation order). */
function commitsFrom(repo: Repo, ref: string | undefined): { sha: string; message: string }[] {
  const tip = resolveRef(repo, ref);
  if (tip === null) return [];
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message });
    for (const parent of commit.parents) queue.push(parent);
  }
  // The walk is a DFS; restore creation order (newest first) by the commit timestamps' order:
  // commits are created in order, so reverse the DFS only when it is a plain chain. Simpler and
  // exact: sort by the embedded timestamp descending.
  const withTs = out.map((entry) => {
    const object = repo.objects.get(entry.sha) as GitObject;
    const commit = parseCommit(object.data);
    const match = / (\d+) \+0000$/.exec(commit.author);
    return { ...entry, ts: match ? Number(match[1]) : 0 };
  });
  withTs.sort((a, b) => b.ts - a.ts);
  return withTs.map(({ sha, message }) => ({ sha, message }));
}

// --------------------------------------------------------------------------- issues and pulls (shared by REST, GraphQL, MCP)

function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
  }
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: tsSeq + 1,
  };
  tsSeq += 1;
  repo.issues.push(issue);
  return issue;
}

function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === null) return { error: `Head branch '${head}' does not exist` };
  if (baseSha === null) return { error: `Base branch '${base}' does not exist` };
  for (const pull of repo.pulls) {
    if (pull.state === 'open' && pull.head.ref === head && pull.base.ref === base) {
      return { error: 'A pull request already exists for this head and base' };
    }
  }
  const files = diffTrees(repo, treeOfCommit(repo, baseSha), treeOfCommit(repo, headSha));
  const pull: Pull = {
    id: nextPullId++,
    number: repo.nextPull++,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    baseSha,
    files,
    seq: tsSeq + 1,
  };
  tsSeq += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Would a squash merge of `pull` conflict with the base branch's current tip? */
function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = branchTip(repo, pull.base.ref);
  if (baseTip === null) return true;
  if (baseTip === pull.baseSha) return false;
  const headTree = treeOfCommit(repo, pull.head.sha);
  const baseTreeNow = treeOfCommit(repo, baseTip);
  const mergeBaseTree = treeOfCommit(repo, pull.baseSha);
  const headChanges = new Map<string, string | null>();
  for (const file of diffTrees(repo, mergeBaseTree, headTree)) {
    const entry = readFileAt(repo, pull.head.sha, file.filename);
    headChanges.set(file.filename, entry === null ? null : entry.oid);
  }
  const baseChanges = new Map<string, string | null>();
  for (const file of diffTrees(repo, mergeBaseTree, baseTreeNow)) {
    const entry = readFileAt(repo, baseTip, file.filename);
    baseChanges.set(file.filename, entry === null ? null : entry.oid);
  }
  for (const [path, headOid] of headChanges) {
    if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return true;
  }
  return false;
}

function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge an open pull request onto its base branch. */
function mergePullRecord(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'Pull request is already closed' };
  if (pullConflicts(repo, pull)) return { ok: false, status: 405, message: 'Merge conflict' };
  const baseTip = branchTip(repo, pull.base.ref);
  if (baseTip === null) return { ok: false, status: 405, message: 'Base branch does not exist' };
  const headTree = treeOfCommit(repo, pull.head.sha);
  if (headTree === null) return { ok: false, status: 405, message: 'Head commit does not exist' };
  const message = `Merge pull request #${pull.number} from ${repo.owner}:${pull.head.ref}\n\n${pull.title}`;
  const sha = makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = isoOf(nextTs());
  pull.merge_commit_sha = sha;
  pull.head.sha = branchTip(repo, pull.head.ref) ?? pull.head.sha;
  pull.base.sha = sha;
  return { ok: true, sha };
}

/** Is `ancestor` reachable from `tip` (a fast-forward check)? */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// --------------------------------------------------------------------------- HTTP plumbing

let reqCounter = 0;

function requestId(): string {
  reqCounter += 1;
  return `forge-${reqCounter.toString(36)}-${tsSeq.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId(),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': requestId(), 'content-length': '0' });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(value: unknown, field: string, fallback = ''): string {
  if (isRecord(value) && typeof value[field] === 'string') return value[field] as string;
  return fallback;
}

function checkAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 7;
}

function pathSegments(pathname: string): string[] {
  const decoded: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    try {
      decoded.push(decodeURIComponent(part));
    } catch {
      decoded.push(part);
    }
  }
  return decoded;
}

/** Paginate a list: returns the page and the Link header value ('' when there is no next page). */
function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage, basePath: string): { page: T[]; link: string } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link = '';
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const url = `http://${host}${basePath}?per_page=${perPage}&page=${page + 1}`;
    link = `<${url}>; rel="next"`;
  }
  return { page: slice, link };
}

// --------------------------------------------------------------------------- REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: globalId('R', repo.dbId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PR', repo.dbId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) === 'MERGEABLE' : null,
    head: {
      ref: pull.head.ref,
      sha: pull.head.sha,
      label: `${repo.owner}:${pull.head.ref}`,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.base.ref,
      sha: pull.base.sha,
      label: `${repo.owner}:${pull.base.ref}`,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    draft: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function globalId(kind: string, dbId: number, num = 0): string {
  return Buffer.from(`${kind}:${dbId}:${num}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; dbId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const dbId = Number(parts[1]);
    const num = Number(parts[2]);
    if (!Number.isFinite(dbId) || !Number.isFinite(num)) return null;
    return { kind: parts[0] as string, dbId, num };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- REST routes

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  // segments[0] is 'api', segments[1] is 'v3'; the rest is the route.
  const route = segments.slice(2);

  if (!checkAuth(req)) {
    unauthorized(res);
    return;
  }

  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  let body: unknown = {};
  if (raw.length > 0) {
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      badRequest(res, 'Invalid JSON body');
      return;
    }
    body = parsed.value;
  }

  // GET /api/v3/ — the API root.
  if (route.length === 0) {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (route.length === 1 && route[0] === 'meta') {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { installed_version: VERSION, verifiable_password_authentication: false });
    return;
  }

  // GET /api/v3/user
  if (route.length === 1 && route[0] === 'user') {
    if (method !== 'GET') {
      notFound(res);
      return;
    }
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }

  // /api/v3/user/repos
  if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
      const { page, link } = paginate(all, query, req, '/api/v3/user/repos');
      sendJson(res, 200, page, link === '' ? {} : { link });
      return;
    }
    if (method === 'POST') {
      const name = strField(body, 'name');
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Invalid repository name' });
        return;
      }
      if (repos.has(repoKey(VIEWER_LOGIN, name))) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return;
      }
      const repo = createRepoRecord(name, strField(body, 'description'), body !== null && isRecord(body) && body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (route.length >= 3 && route[0] === 'repos') {
    const owner = route[1] as string;
    const name = route[2] as string;
    const repo = findRepo(owner, name);
    if (repo === null) {
      notFound(res);
      return;
    }
    const rest = route.slice(3);

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        }
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        sendNoContent(res);
        return;
      }
      notFound(res);
      return;
    }

    // /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(res, 200, list);
      return;
    }

    // /repos/{o}/{r}/branches/{branch}
    if (rest.length === 2 && rest[0] === 'branches') {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const sha = branchTip(repo, rest[1] as string);
      if (sha === null) {
        notFound(res, 'Branch not found');
        return;
      }
      sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
      return;
    }

    // /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        notFound(res);
        return;
      }
      const sha = query.get('sha') ?? undefined;
      const list = commitsFrom(repo, sha).map((entry) => ({
        sha: entry.sha,
        commit: { message: entry.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      }));
      const { page, link } = paginate(list, query, req, `/api/v3/repos/${owner}/${name}/commits`);
      sendJson(res, 200, page, link === '' ? {} : { link });
      return;
    }

    // /repos/{o}/{r}/git/refs (create a ref) and /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${name}/git/refs/${ref}` });
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const list = [...repo.refs.entries()]
          .map(([ref, sha]) => ({ ref, object: { sha } }))
          .sort((a, b) => (a.ref < b.ref ? -1 : 1));
        sendJson(res, 200, list);
        return;
      }
      if (rest.length === 4 && rest[2] === 'heads' && method === 'GET') {
        const sha = branchTip(repo, rest[3] as string);
        if (sha === null) {
          notFound(res, 'Reference does not exist');
          return;
        }
        sendJson(res, 200, { ref: `refs/heads/${rest[3]}`, object: { sha } });
        return;
      }
      notFound(res);
      return;
    }

    // /repos/{o}/{r}/contents[/{path}]
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const message = strField(body, 'message', 'update');
        const contentB64 = strField(body, 'content');
        const branch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : undefined;
        const sha = isRecord(body) && typeof body.sha === 'string' ? (body.sha as string) : undefined;
        if (contentB64 === '') {
          sendJson(res, 422, { message: 'content is required' });
          return;
        }
        const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        const tip = branch === undefined ? branchTip(repo, repo.defaultBranch) : branchTip(repo, branch);
        if (sha !== undefined && tip !== null) {
          const current = readFileAt(repo, tip, contentPath);
          if (current !== null && current.oid.toLowerCase() !== sha.toLowerCase()) {
            sendJson(res, 409, { message: 'sha does not match the current file' });
            return;
          }
        }
        const written = writeContentFile(repo, branch, contentPath, content, message);
        sendJson(
          res,
          written.created ? 201 : 200,
          {
            content: { name: contentPath.split('/').pop() ?? contentPath, path: contentPath, sha: written.blobSha, size: content.length, encoding: 'base64', type: 'file' },
            commit: { sha: written.commitSha, message },
          },
        );
        return;
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const tip = resolveRef(repo, ref);
        if (tip === null) {
          notFound(res, 'Not Found');
          return;
        }
        const file = readFileAt(repo, tip, contentPath);
        if (file !== null) {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: contentPath.split('/').pop() ?? contentPath,
            path: contentPath,
            content: file.data.toString('base64'),
            sha: file.oid,
          });
          return;
        }
        const dir = listDirAt(repo, tip, contentPath);
        if (dir !== null) {
          sendJson(
            res,
            200,
            dir.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.sha, size: entry.type === 'file' ? 0 : 0 })),
          );
          return;
        }
        notFound(res, 'Not Found');
        return;
      }
      if (method === 'DELETE') {
        const message = strField(body, 'message', 'delete');
        const branch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : undefined;
        const deleted = deleteContentFile(repo, branch, contentPath, message);
        if (deleted === null) {
          notFound(res, 'Not Found');
          return;
        }
        sendJson(res, 200, { commit: { sha: deleted.commitSha, message } });
        return;
      }
      notFound(res);
      return;
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (method === 'POST') {
        const name = strField(body, 'name');
        if (name === '') {
          sendJson(res, 422, { message: 'Label name is required' });
          return;
        }
        const color = strField(body, 'color', 'ededed');
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(res, 201, labelJson(existing));
          return;
        }
        const label: Label = { name, color, description: strField(body, 'description') };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      notFound(res);
      return;
    }

    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = strField(body, 'title');
          if (title === '') {
            sendJson(res, 422, { message: 'Title is required' });
            return;
          }
          const labels = isRecord(body) && Array.isArray(body.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
          const created = createIssueRecord(repo, title, strField(body, 'body'), labels);
          if ('error' in created) {
            sendJson(res, 422, { message: created.error });
            return;
          }
          sendJson(res, 201, issueJson(repo, created));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
          }
          const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), query, req, `/api/v3/repos/${owner}/${name}/issues`);
          sendJson(res, 200, page, link === '' ? {} : { link });
          return;
        }
        notFound(res);
        return;
      }
      const number = Number(rest[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (issue === undefined) {
          notFound(res, 'Issue not found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (isRecord(body)) {
            if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) {
          notFound(res, 'Issue not found');
          return;
        }
        if (method === 'POST') {
          const text = strField(body, 'body');
          const comment: Comment = { id: nextCommentId++, body: text, user: VIEWER_LOGIN };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, node_id: globalId('C', repo.dbId, comment.id), body: text, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } });
          return;
        }
        if (method === 'GET') {
          sendJson(
            res,
            200,
            issue.comments.map((comment) => ({ id: comment.id, node_id: globalId('C', repo.dbId, comment.id), body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' } })),
          );
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }

    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = strField(body, 'title');
          const head = strField(body, 'head');
          const base = strField(body, 'base', repo.defaultBranch);
          if (title === '' || head === '') {
            sendJson(res, 422, { message: 'title and head are required' });
            return;
          }
          const created = createPullRecord(repo, title, strField(body, 'body'), head, base);
          if ('error' in created) {
            sendJson(res, 422, { message: created.error });
            return;
          }
          sendJson(res, 201, pullJson(repo, created));
          return;
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          list.sort((a, b) => b.seq - a.seq);
          const { page, link } = paginate(list.map((pull) => pullJson(repo, pull)), query, req, `/api/v3/repos/${owner}/${name}/pulls`);
          sendJson(res, 200, page, link === '' ? {} : { link });
          return;
        }
        notFound(res);
        return;
      }
      const number = Number(rest[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (pull === undefined) {
          notFound(res, 'Pull request not found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (pull === undefined) {
          notFound(res, 'Pull request not found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, pull.files);
          return;
        }
        notFound(res);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (pull === undefined) {
          notFound(res, 'Pull request not found');
          return;
        }
        if (method === 'PUT') {
          const merged = mergePullRecord(repo, pull);
          if (!merged.ok) {
            sendJson(res, merged.status, { message: merged.message });
            return;
          }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull request #${pull.number} merged` });
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }

    notFound(res);
    return;
  }

  notFound(res);
}

// --------------------------------------------------------------------------- GraphQL

type GqlValue = null | boolean | number | string | { [key: string]: GqlValue } | GqlValue[];
interface GqlField {
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selection: GqlField[] | null;
  fragments: string[] | null;
  kind: 'field' | 'inlineFragment';
  typeCondition: string | null;
}
interface GqlDocument {
  operation: string | null;
  variables: Record<string, GqlValue>;
  varDefs: Record<string, { type: string; defaultValue?: GqlValue }>;
  root: GqlField[];
  fragments: Map<string, { typeCondition: string; selection: GqlField[] }>;
  errors: string[];
}

const NO_SUCH_FIELD = 'noSuchFieldOnViewer';

class GqlParser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipWhitespace(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipWhitespace();
    return this.text[this.pos] ?? '';
  }

  private expect(value: string): void {
    this.skipWhitespace();
    if (!this.text.startsWith(value, this.pos)) throw new Error(`expected ${value}`);
    this.pos += value.length;
  }

  private match(value: string): boolean {
    this.skipWhitespace();
    if (this.text.startsWith(value, this.pos)) {
      this.pos += value.length;
      return true;
    }
    return false;
  }

  private readName(): string {
    this.skipWhitespace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!match) throw new Error('expected name');
    this.pos += match[0].length;
    return match[0];
  }

  private readString(): string {
    this.skipWhitespace();
    if (this.text[this.pos] === '"') {
      const end = this.text.indexOf('"', this.pos + 1);
      if (end < 0) throw new Error('unterminated string');
      const value = JSON.parse(this.text.slice(this.pos, end + 1)) as string;
      this.pos = end + 1;
      return value;
    }
    if (this.text.startsWith('"""', this.pos)) {
      const end = this.text.indexOf('"""', this.pos + 3);
      if (end < 0) throw new Error('unterminated block string');
      const value = this.text.slice(this.pos + 3, end);
      this.pos = end + 3;
      return value;
    }
    throw new Error('expected string');
  }

  private readValue(): GqlValue {
    this.skipWhitespace();
    const ch = this.text[this.pos] ?? '';
    if (ch === '{') {
      this.pos += 1;
      const obj: Record<string, GqlValue> = {};
      while (!this.match('}')) {
        const key = this.readName();
        this.expect(':');
        obj[key] = this.readValue();
      }
      return obj;
    }
    if (ch === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (!this.match(']')) items.push(this.readValue());
      return items;
    }
    if (ch === '"') return this.readString();
    if (ch === '$') {
      this.pos += 1;
      return { __variable: this.readName() } as unknown as GqlValue;
    }
    const numMatch = /^-?\d+(\.\d+)?/.exec(this.text.slice(this.pos));
    if (numMatch !== null) {
      this.pos += numMatch[0].length;
      return Number(numMatch[0]);
    }
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { __enum: name } as unknown as GqlValue;
  }

  private readArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (!this.match('(')) return args;
    while (!this.match(')')) {
      const key = this.readName();
      this.expect(':');
      // Stored raw on purpose: $variables are resolved later, once the real variable
      // values (and defaults) are known.
      args[key] = this.readValue();
    }
    return args;
  }

  private resolveValue(value: GqlValue, variables: Record<string, GqlValue>): GqlValue {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, GqlValue>;
      if ('__variable' in record && typeof record.__variable === 'string') {
        return variables[record.__variable] ?? null;
      }
      if ('__enum' in record && typeof record.__enum === 'string') return record.__enum as string;
      const out: Record<string, GqlValue> = {};
      for (const [key, entry] of Object.entries(record)) out[key] = this.resolveValue(entry, variables);
      return out;
    }
    if (Array.isArray(value)) return value.map((entry) => this.resolveValue(entry, variables));
    return value;
  }

  private readSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (!this.match('}')) {
      if (this.match('...')) {
        if (this.match('on')) {
          const typeCondition = this.readName();
          const selection = this.readSelectionSet();
          fields.push({ alias: '', name: '', args: {}, selection, fragments: null, kind: 'inlineFragment', typeCondition });
        } else {
          const name = this.readName();
          fields.push({ alias: '', name: '', args: {}, selection: null, fragments: [name], kind: 'field', typeCondition: null });
        }
        continue;
      }
      let name = this.readName();
      let alias = name;
      if (this.match(':')) {
        alias = name;
        name = this.readName();
      }
      const args = this.readArguments();
      let selection: GqlField[] | null = null;
      if (this.peek() === '{') selection = this.readSelectionSet();
      fields.push({ alias, name, args, selection, fragments: null, kind: 'field', typeCondition: null });
    }
    return fields;
  }

  parse(variables: Record<string, GqlValue>): GqlDocument {
    const document: GqlDocument = {
      operation: null,
      variables,
      varDefs: {},
      root: [],
      fragments: new Map(),
      errors: [],
    };
    this.skipWhitespace();
    let keyword = '';
    if (this.text.startsWith('query', this.pos) || this.text.startsWith('mutation', this.pos)) {
      keyword = this.text.startsWith('query', this.pos) ? 'query' : 'mutation';
      this.pos += keyword.length;
      this.skipWhitespace();
      if (/[A-Za-z_]/.test(this.text[this.pos] ?? '')) document.operation = this.readName();
      if (this.match('(')) {
        while (!this.match(')')) {
          this.expect('$');
          const varName = this.readName();
          this.expect(':');
          const type = this.readName();
          if (this.match('!')) {}
          let defaultValue: GqlValue | undefined;
          if (this.match('=')) defaultValue = this.readValue();
          document.varDefs[varName] = defaultValue === undefined ? { type } : { type, defaultValue };
        }
      }
    }
    // Variable defaults apply before argument resolution, so a defaulted $var resolves
    // to its default when the caller did not supply it.
    for (const [name, def] of Object.entries(document.varDefs)) {
      if (!(name in document.variables) && def.defaultValue !== undefined) document.variables[name] = def.defaultValue;
    }
    // Re-resolve arguments now that the variable values are known.
    const resolveFields = (fields: GqlField[]): GqlField[] =>
      fields.map((field) => ({
        ...field,
        args: Object.fromEntries(Object.entries(field.args).map(([key, value]) => [key, this.resolveValue(value, variables)])),
        selection: field.selection === null ? null : resolveFields(field.selection),
      }));
    document.root = resolveFields(this.readSelectionSet());
    // Fragments may follow the operation.
    this.skipWhitespace();
    while (this.text.startsWith('fragment', this.pos)) {
      this.pos += 'fragment'.length;
      const name = this.readName();
      this.expect('on');
      const typeCondition = this.readName();
      const selection = resolveFields(this.readSelectionSet());
      document.fragments.set(name, { typeCondition, selection });
      this.skipWhitespace();
    }
    // Variable defaults.
    for (const [name, def] of Object.entries(document.varDefs)) {
      if (!(name in document.variables) && def.defaultValue !== undefined) document.variables[name] = def.defaultValue;
    }
    return document;
  }
}

type GqlContext = { document: GqlDocument; errors: string[] };

/** Resolve one field's name inside the introspection type map. */
const INTROSPECTION: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

function encodeCursor(value: number): string {
  return Buffer.from(`cursor:${value}`).toString('base64');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string') return 0;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function repoForId(dbId: number): Repo | null {
  for (const repo of repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function issueByNodeId(id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const repo = repoForId(decoded.dbId);
  if (repo === null) return null;
  const issue = repo.issues.find((entry) => entry.number === decoded.num);
  return issue === undefined ? null : { repo, issue };
}

function pullByNodeId(id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const repo = repoForId(decoded.dbId);
  if (repo === null) return null;
  const pull = repo.pulls.find((entry) => entry.number === decoded.num);
  return pull === undefined ? null : { repo, pull };
}

function expandSelection(
  document: GqlDocument,
  fields: GqlField[] | null,
): GqlField[] {
  if (fields === null) return [];
  const out: GqlField[] = [];
  for (const field of fields) {
    if (field.fragments !== null) {
      for (const name of field.fragments) {
        const fragment = document.fragments.get(name);
        if (fragment) out.push(...expandSelection(document, fragment.selection));
      }
      continue;
    }
    out.push({
      ...field,
      selection: field.selection === null ? null : expandSelection(document, field.selection),
    });
  }
  return out;
}

function resolveObject(document: GqlDocument, typeName: string, value: Record<string, unknown>, fields: GqlField[] | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of expandSelection(document, fields)) {
    if (field.kind === 'inlineFragment') {
      if (field.typeCondition !== null && field.typeCondition !== typeName) continue;
      Object.assign(out, resolveObject(document, typeName, value, field.selection));
      continue;
    }
    const resolved = resolveField(document, typeName, value, field);
    out[field.alias] = resolved;
  }
  return out;
}

function fieldNotFound(document: GqlDocument, typeName: string, fieldName: string): void {
  document.errors.push(`${NO_SUCH_FIELD}: field '${fieldName}' not found on type '${typeName}'`);
}

function resolveField(
  document: GqlDocument,
  typeName: string,
  value: Record<string, unknown>,
  field: GqlField,
): unknown {
  const name = field.name;
  // Type-level __typename is always available.
  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') {
        return resolveObject(document, 'User', { login: VIEWER_LOGIN }, field.selection);
      }
      if (name === 'repository') {
        const owner = String(field.args.owner ?? '');
        const repoName = String(field.args.name ?? '');
        const repo = findRepo(owner, repoName);
        if (repo === null) return null;
        return resolveObject(document, 'Repository', repoToGql(repo), field.selection);
      }
      if (name === 'node') {
        const id = String(field.args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'R') {
          const repo = repoForId(decoded.dbId);
          return repo === null ? null : resolveObject(document, 'Repository', repoToGql(repo), field.selection);
        }
        if (decoded.kind === 'I') {
          const found = issueByNodeId(id);
          return found === null ? null : resolveObject(document, 'Issue', issueToGql(found.repo, found.issue), field.selection);
        }
        if (decoded.kind === 'PR') {
          const found = pullByNodeId(id);
          return found === null ? null : resolveObject(document, 'PullRequest', pullToGql(found.repo, found.pull), field.selection);
        }
        return null;
      }
      fieldNotFound(document, 'Query', name);
      return null;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (field.args.input ?? {}) as Record<string, unknown>;
        const repositoryId = String(input.repositoryId ?? '');
        const decoded = decodeGlobalId(repositoryId);
        const repo = decoded === null ? null : repoForId(decoded.dbId);
        if (repo === null) {
          fieldNotFound(document, 'Mutation', name);
          return null;
        }
        const created = createIssueRecord(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) {
          document.errors.push(created.error);
          return null;
        }
        return resolveObject(document, 'CreateIssuePayload', { issue: issueToGql(repo, created) }, field.selection);
      }
      if (name === 'closeIssue') {
        const input = (field.args.input ?? {}) as Record<string, unknown>;
        const found = issueByNodeId(String(input.issueId ?? ''));
        if (found === null) {
          fieldNotFound(document, 'Mutation', name);
          return null;
        }
        found.issue.state = 'closed';
        return resolveObject(document, 'CloseIssuePayload', { issue: issueToGql(found.repo, found.issue) }, field.selection);
      }
      if (name === 'createPullRequest') {
        const input = (field.args.input ?? {}) as Record<string, unknown>;
        const repositoryId = String(input.repositoryId ?? '');
        const decoded = decodeGlobalId(repositoryId);
        const repo = decoded === null ? null : repoForId(decoded.dbId);
        if (repo === null) {
          fieldNotFound(document, 'Mutation', name);
          return null;
        }
        const created = createPullRecord(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) {
          document.errors.push(created.error);
          return null;
        }
        return resolveObject(document, 'CreatePullRequestPayload', { pullRequest: pullToGql(repo, created) }, field.selection);
      }
      if (name === 'mergePullRequest') {
        const input = (field.args.input ?? {}) as Record<string, unknown>;
        const found = pullByNodeId(String(input.pullRequestId ?? ''));
        if (found === null) {
          fieldNotFound(document, 'Mutation', name);
          return null;
        }
        const merged = mergePullRecord(found.repo, found.pull);
        if (!merged.ok) {
          document.errors.push(merged.message);
          return null;
        }
        return resolveObject(document, 'MergePullRequestPayload', { pullRequest: pullToGql(found.repo, found.pull) }, field.selection);
      }
      if (name === 'addComment') {
        const input = (field.args.input ?? {}) as Record<string, unknown>;
        const found = issueByNodeId(String(input.subjectId ?? ''));
        if (found === null) {
          fieldNotFound(document, 'Mutation', name);
          return null;
        }
        const comment: Comment = { id: nextCommentId++, body: String(input.body ?? ''), user: VIEWER_LOGIN };
        found.issue.comments.push(comment);
        const node = { id: globalId('C', found.repo.dbId, comment.id), body: comment.body };
        return resolveObject(document, 'AddCommentPayload', { commentEdge: { node } }, field.selection);
      }
      fieldNotFound(document, 'Mutation', name);
      return null;
    }
    case 'User': {
      if (name === 'login') return value.login;
      if (name === 'id') return globalId('U', VIEWER_ID);
      fieldNotFound(document, 'User', name);
      return null;
    }
    case 'Repository': {
      const repo = value as unknown as { __repo: Repo };
      if (name === 'id') return globalId('R', repo.__repo.dbId);
      if (name === 'databaseId') return repo.__repo.dbId;
      if (name === 'name') return repo.__repo.name;
      if (name === 'nameWithOwner') return `${repo.__repo.owner}/${repo.__repo.name}`;
      if (name === 'owner') return resolveObject(document, 'User', { login: repo.__repo.owner }, field.selection);
      if (name === 'defaultBranchRef') {
        const branch = repo.__repo.defaultBranch;
        const sha = branchTip(repo.__repo, branch);
        return sha === null ? null : resolveObject(document, 'Ref', { name: branch }, field.selection);
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'issue') {
        const number = Number(field.args.number ?? 0);
        const issue = repo.__repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : resolveObject(document, 'Issue', issueToGql(repo.__repo, issue), field.selection);
      }
      if (name === 'issues') {
        const nodes = filterIssues(repo.__repo, field.args);
        const connection = paginateConnection(nodes, field.args);
        return resolveObject(document, 'IssueConnection', connection, field.selection);
      }
      if (name === 'pullRequests') {
        const nodes = [...repo.__repo.pulls].sort((a, b) => b.seq - a.seq).map((pull) => pullToGql(repo.__repo, pull));
        const connection = paginateConnection(nodes, field.args);
        return resolveObject(document, 'PullRequestConnection', connection, field.selection);
      }
      if (name === 'pullRequest') {
        const number = Number(field.args.number ?? 0);
        const pull = repo.__repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : resolveObject(document, 'PullRequest', pullToGql(repo.__repo, pull), field.selection);
      }
      fieldNotFound(document, 'Repository', name);
      return null;
    }
    case 'Issue': {
      const issue = value as unknown as { __issue: Issue; __repo: Repo };
      if (name === 'id') return globalId('I', issue.__repo.dbId, issue.__issue.number);
      if (name === 'number') return issue.__issue.number;
      if (name === 'title') return issue.__issue.title;
      if (name === 'state') return issue.__issue.state.toUpperCase();
      if (name === 'body') return issue.__issue.body;
      fieldNotFound(document, 'Issue', name);
      return null;
    }
    case 'PullRequest': {
      const pull = value as unknown as { __pull: Pull; __repo: Repo };
      if (name === 'id') return globalId('PR', pull.__repo.dbId, pull.__pull.number);
      if (name === 'number') return pull.__pull.number;
      if (name === 'headRefName') return pull.__pull.head.ref;
      if (name === 'baseRefName') return pull.__pull.base.ref;
      if (name === 'mergeable') return pullMergeable(pull.__repo, pull.__pull);
      if (name === 'state') return pull.__pull.state.toUpperCase();
      if (name === 'merged') return pull.__pull.merged;
      if (name === 'files') {
        const nodes = pull.__pull.files.map((file) => ({ path: file.filename, __isPullFile: true }));
        const connection = paginateConnection(nodes, field.args);
        return resolveObject(document, 'PullRequestChangedFileConnection', connection, field.selection);
      }
      fieldNotFound(document, 'PullRequest', name);
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const connection = value as unknown as { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount: number };
      if (name === 'nodes') {
        const nodeType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
        return connection.nodes.map((node) => resolveObject(document, nodeType, node as Record<string, unknown>, field.selection));
      }
      if (name === 'edges') {
        const nodeType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
        return connection.nodes.map((node, index) => {
          const cursor = encodeCursor(index + 1);
          return resolveObject(document, 'Edge', { node, cursor }, field.selection);
        });
      }
      if (name === 'pageInfo') return resolveObject(document, 'PageInfo', connection.pageInfo, field.selection);
      if (name === 'totalCount') return connection.totalCount;
      fieldNotFound(document, typeName, name);
      return null;
    }
    case 'Edge': {
      if (name === 'node') {
        const node = value.node as Record<string, unknown>;
        const typeName = node.__isPullFile ? 'PullRequestChangedFile' : node.__isPull ? 'PullRequest' : 'Issue';
        return resolveObject(document, typeName, node, field.selection);
      }
      if (name === 'cursor') return value.cursor;
      fieldNotFound(document, 'Edge', name);
      return null;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'hasPreviousPage') return value.hasPreviousPage;
      if (name === 'startCursor') return value.startCursor;
      if (name === 'endCursor') return value.endCursor;
      fieldNotFound(document, 'PageInfo', name);
      return null;
    }
    case 'Ref': {
      if (name === 'name') return value.name;
      fieldNotFound(document, 'Ref', name);
      return null;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return (value as { path: string }).path;
      fieldNotFound(document, 'PullRequestChangedFile', name);
      return null;
    }
    case 'CreateIssuePayload': {
      if (name === 'issue') return resolveObject(document, 'Issue', value.issue as Record<string, unknown>, field.selection);
      fieldNotFound(document, 'CreateIssuePayload', name);
      return null;
    }
    case 'CloseIssuePayload': {
      if (name === 'issue') return resolveObject(document, 'Issue', value.issue as Record<string, unknown>, field.selection);
      fieldNotFound(document, 'CloseIssuePayload', name);
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (name === 'pullRequest') return resolveObject(document, 'PullRequest', value.pullRequest as Record<string, unknown>, field.selection);
      fieldNotFound(document, 'CreatePullRequestPayload', name);
      return null;
    }
    case 'MergePullRequestPayload': {
      if (name === 'pullRequest') return resolveObject(document, 'PullRequest', value.pullRequest as Record<string, unknown>, field.selection);
      fieldNotFound(document, 'MergePullRequestPayload', name);
      return null;
    }
    case 'AddCommentPayload': {
      if (name === 'commentEdge') {
        const edge = value.commentEdge as { node: Record<string, unknown> };
        return resolveObject(document, 'AddCommentEdge', { node: edge.node }, field.selection);
      }
      fieldNotFound(document, 'AddCommentPayload', name);
      return null;
    }
    case 'AddCommentEdge': {
      if (name === 'node') return resolveObject(document, 'IssueComment', value.node as Record<string, unknown>, field.selection);
      fieldNotFound(document, 'AddCommentEdge', name);
      return null;
    }
    case 'IssueComment': {
      if (name === 'id') return (value as { id: string }).id;
      if (name === 'body') return (value as { body: string }).body;
      fieldNotFound(document, 'IssueComment', name);
      return null;
    }
    case '__Type': {
      if (name === 'fields') {
        const typeName = (value as { name: string }).name;
        const info = INTROSPECTION[typeName];
        const fieldNames = info?.fields ?? [];
        return fieldNames.map((fieldName) => ({ name: fieldName }));
      }
      if (name === 'enumValues') {
        const typeName = (value as { name: string }).name;
        const info = INTROSPECTION[typeName];
        return (info?.enumValues ?? []).map((enumValue) => ({ name: enumValue }));
      }
      if (name === 'name') return (value as { name: string }).name;
      if (name === 'kind') return 'OBJECT';
      fieldNotFound(document, '__Type', name);
      return null;
    }
    case 'TypeField': {
      if (name === 'name') return (value as { name: string }).name;
      fieldNotFound(document, 'TypeField', name);
      return null;
    }
    default:
      fieldNotFound(document, typeName, name);
      return null;
  }
}

function filterIssues(repo: Repo, args: Record<string, GqlValue>): Record<string, unknown>[] {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = args.orderBy;
  let direction = 'DESC';
  if (isRecord(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction;
  // orderBy.field: only CREATED_AT exists; creation order is the sequence.
  list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
  return list.map((issue) => issueToGql(repo, issue));
}

function paginateConnection(
  nodes: Record<string, unknown>[],
  args: Record<string, GqlValue>,
): { nodes: Record<string, unknown>[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = decodeCursor(args.after);
  const slice = nodes.slice(after, after + first);
  const endCursor = slice.length > 0 ? encodeCursor(after + slice.length) : null;
  return {
    nodes: slice,
    pageInfo: {
      hasNextPage: after + first < nodes.length,
      hasPreviousPage: after > 0,
      startCursor: slice.length > 0 ? encodeCursor(after + 1) : null,
      endCursor,
    },
    totalCount: nodes.length,
  };
}

function repoToGql(repo: Repo): Record<string, unknown> {
  return { __repo: repo };
}

function issueToGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __repo: repo, __issue: issue };
}

function pullToGql(repo: Repo, pull: Pull): Record<string, unknown> {
  return { __repo: repo, __pull: pull, __isPull: true };
}

function executeGraphql(document: GqlDocument): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const data: Record<string, unknown> = {};
  const rootType = document.root.some((field) => field.name === 'createIssue' || field.name === 'closeIssue' || field.name === 'createPullRequest' || field.name === 'mergePullRequest' || field.name === 'addComment')
    ? 'Mutation'
    : 'Query';
  for (const field of expandSelection(document, document.root)) {
    if (field.kind === 'inlineFragment') {
      if (field.typeCondition !== null && field.typeCondition !== rootType) continue;
      Object.assign(data, resolveObject(document, rootType, {}, field.selection));
      continue;
    }
    if (field.name === '__type') {
      const typeName = String(field.args.name ?? '');
      data[field.alias] = resolveObject(document, '__Type', { name: typeName }, field.selection);
      continue;
    }
    if (field.name === '__schema') {
      data[field.alias] = null;
      continue;
    }
    data[field.alias] = resolveField(document, rootType, {}, field);
  }
  if (document.errors.length > 0) {
    return { data, errors: document.errors.map((message) => ({ message })) };
  }
  return { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req)) {
    unauthorized(res);
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    badRequest(res, 'Invalid JSON body');
    return;
  }
  const executeOne = (body: unknown): unknown => {
    if (!isRecord(body)) {
      return { data: null, errors: [{ message: 'GraphQL body must be an object' }] };
    }
    const query = typeof body.query === 'string' ? body.query : '';
    const variables = isRecord(body.variables) ? (body.variables as Record<string, GqlValue>) : {};
    const parser = new GqlParser(query);
    let document: GqlDocument;
    try {
      document = parser.parse(variables);
    } catch {
      return { data: null, errors: [{ message: 'GraphQL parse error' }] };
    }
    return executeGraphql(document);
  };
  const result = Array.isArray(parsed.value) ? parsed.value.map(executeOne) : executeOne(parsed.value);
  sendJson(res, 200, result);
}

// --------------------------------------------------------------------------- MCP

const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  const lower: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) lower[key.toLowerCase()] = value;
  for (const name of names) {
    if (lower[name.toLowerCase()] !== undefined) return lower[name.toLowerCase()];
  }
  return undefined;
}

function mcpToolResult(
  toolName: string,
  args: Record<string, unknown>,
): { value: unknown; isError?: boolean } {
  const name = toolName.toLowerCase();
  const owner = String(pickArg(args, 'owner') ?? '');
  const repoName = String(pickArg(args, 'repo', 'repository') ?? '');
  if (name === 'create_repo') {
    const repoNameArg = String(pickArg(args, 'name') ?? '');
    if (repoNameArg === '') return { value: { error: 'name is required' }, isError: true };
    if (repos.has(repoKey(VIEWER_LOGIN, repoNameArg))) return { value: { error: 'Repository already exists' }, isError: true };
    const repo = createRepoRecord(repoNameArg, String(pickArg(args, 'description') ?? ''), pickArg(args, 'private') === true);
    return { value: repoJson(repo) };
  }
  const repo = repoName === '' ? null : findRepo(owner === '' ? VIEWER_LOGIN : owner, repoName);
  if (repo === null) return { value: { error: `Repository ${owner}/${repoName} not found` }, isError: true };
  if (name === 'get_repo') return { value: repoJson(repo) };
  if (name === 'create_issue') {
    const title = String(pickArg(args, 'title') ?? '');
    if (title === '') return { value: { error: 'title is required' }, isError: true };
    const created = createIssueRecord(repo, title, String(pickArg(args, 'body') ?? ''), []);
    if ('error' in created) return { value: { error: created.error }, isError: true };
    return { value: issueJson(repo, created) };
  }
  if (name === 'list_issues') {
    const state = String(pickArg(args, 'state') ?? 'open');
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    return { value: list.map((issue) => issueJson(repo, issue)) };
  }
  if (name === 'create_pull_request') {
    const title = String(pickArg(args, 'title') ?? '');
    const head = String(pickArg(args, 'head', 'head_ref') ?? '');
    const base = String(pickArg(args, 'base', 'base_ref') ?? repo.defaultBranch);
    if (title === '' || head === '') return { value: { error: 'title and head are required' }, isError: true };
    const created = createPullRecord(repo, title, String(pickArg(args, 'body') ?? ''), head, base);
    if ('error' in created) return { value: { error: created.error }, isError: true };
    return { value: pullJson(repo, created) };
  }
  if (name === 'merge_pull_request') {
    const number = Number(pickArg(args, 'pull_number', 'pullNumber', 'number') ?? 0);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return { value: { error: 'Pull request not found' }, isError: true };
    const merged = mergePullRecord(repo, pull);
    if (!merged.ok) return { value: { error: merged.message }, isError: true };
    return { value: { merged: true, sha: merged.sha, number: pull.number } };
  }
  return { value: { error: `Unknown tool: ${toolName}` }, isError: true };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkAuth(req)) {
    unauthorized(res);
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const body = parsed.value;
  if (!isRecord(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id === undefined ? null : body.id;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};

  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    const requested = String(params.protocolVersion ?? '');
    const protocolVersion = requested === '' ? '2026-07-28' : requested;
    reply({
      supportedVersions: ['2026-07-28'],
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-forge', version: VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'github-core-forge', version: VERSION },
        'io.modelcontextprotocol/protocolVersion': protocolVersion,
      },
    });
    return;
  }
  if (method === 'initialize') {
    const offered = Array.isArray(params.protocolVersions) ? (params.protocolVersions as unknown[]).map(String) : [];
    const requested = String(params.protocolVersion ?? '');
    const protocolVersion = offered.includes('2026-07-28') ? '2026-07-28' : requested !== '' ? requested : '2026-07-28';
    reply({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-forge', version: VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: 'github-core-forge', version: VERSION },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') {
    res.writeHead(202, { 'x-github-request-id': requestId(), 'content-length': '0' });
    res.end();
    return;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = String(params.name ?? '');
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((tool) => tool.name === toolName.toLowerCase());
    if (!known) {
      replyError(-32602, `Unknown tool: ${toolName}`);
      return;
    }
    const { value, isError } = mcpToolResult(toolName, args);
    reply({
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      ...(isError ? { isError: true } : {}),
    });
    return;
  }
  if (method === 'ping') {
    reply({});
    return;
  }
  replyError(-32601, `Method not found: ${method}`);
}

// --------------------------------------------------------------------------- git smart HTTP

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/main';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';

function refLines(repo: Repo): { ref: string; oid: string; isHead: boolean }[] {
  const lines: { ref: string; oid: string; isHead: boolean }[] = [];
  const headTip = branchTip(repo, repo.defaultBranch);
  if (headTip !== null) lines.push({ ref: 'HEAD', oid: headTip, isHead: true });
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of entries) lines.push({ ref, oid, isHead: false });
  return lines;
}

function annotatedTagPeeled(repo: Repo, tagOid: string): string | null {
  const object = repo.objects.get(tagOid);
  if (!object || object.type !== 'tag') return null;
  const tag = parseTag(object.data);
  const target = repo.objects.get(tag.object);
  if (!target) return null;
  return target.type === 'tag' ? annotatedTagPeeled(repo, tag.object) : tag.object;
}

function advertise(repo: Repo, service: 'upload' | 'receive', version2: boolean): Buffer {
  const parts: Buffer[] = [];
  if (service === 'upload') {
    if (version2) {
      parts.push(pktLine('version 2\n'));
      parts.push(pktLine('ls-refs=unborn\n'));
      parts.push(pktLine('fetch=shallow wait-for-done filter\n'));
      parts.push(pktLine('object-format=sha1\n'));
      parts.push(pktFlush());
      return Buffer.concat(parts);
    }
    parts.push(pktLine('# service=git-upload-pack\n'));
    parts.push(pktFlush());
  } else {
    parts.push(pktLine('# service=git-receive-pack\n'));
    parts.push(pktFlush());
  }
  const caps = service === 'upload' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = refLines(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((entry, index) => {
      const first = index === 0;
      const line = `${entry.oid} ${entry.ref}${first ? `\0${caps}` : ''}\n`;
      parts.push(pktLine(line));
      if (entry.isHead === false && entry.ref.startsWith('refs/tags/')) {
        const peeled = annotatedTagPeeled(repo, entry.oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${entry.ref}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: Set<string>, refPrefix: string | null): Buffer {
  const parts: Buffer[] = [];
  const wantPeel = args.has('peel');
  const wantSymrefs = args.has('symrefs');
  const wantUnborn = args.has('unborn');
  const headTip = branchTip(repo, repo.defaultBranch);
  const include = (ref: string): boolean => refPrefix === null || ref.startsWith(refPrefix);
  if (headTip !== null && include('HEAD')) {
    let line = `${headTip} HEAD`;
    if (wantSymrefs) line += ' symref-target:refs/heads/main';
    parts.push(pktLine(`${line}\n`));
  }
  if (headTip === null && wantUnborn && include('HEAD')) {
    parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  const entries = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [ref, oid] of entries) {
    if (!include(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const peeled = annotatedTagPeeled(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Depth-limited reachability: commit `root` at depth `depth`, walking parents only. */
function depthLimitedCommits(repo: Repo, root: string, depth: number): { commits: Set<string>; boundary: Set<string> } {
  const commits = new Set<string>();
  const boundary = new Set<string>();
  if (depth === 0) return { commits, boundary };
  const queue: { oid: string; depth: number }[] = [{ oid: root, depth }];
  while (queue.length > 0) {
    const { oid, depth: d } = queue.pop() as { oid: string; depth: number };
    if (commits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    commits.add(oid);
    if (d === 1) {
      boundary.add(oid);
      continue;
    }
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: d - 1 });
  }
  return { commits, boundary };
}

function fetchPack(repo: Repo, wants: string[], haves: Set<string>, depth: number | null, knownShallow: Set<string>): Buffer {
  // Resolve each want to a commit (following annotated tags), keeping the tag objects
  // themselves: a clone that wants a tag ref must receive the tag object, not just its target.
  const wantCommits: string[] = [];
  const wantTagOids: string[] = [];
  for (const want of wants) {
    let currentOid = want;
    let object = repo.objects.get(currentOid);
    while (object !== undefined && object.type === 'tag') {
      wantTagOids.push(currentOid);
      const tag = parseTag(object.data);
      currentOid = tag.object;
      object = repo.objects.get(currentOid);
    }
    if (object !== undefined && object.type === 'commit') wantCommits.push(currentOid);
  }
  const shallowSet = new Set<string>();
  const unshallowSet = new Set<string>();
  const included = new Set<string>();
  if (depth === null) {
    for (const want of wantCommits) {
      const reachable = collectReachable([want], (oid) => repo.objects.get(oid));
      for (const oid of reachable) included.add(oid);
    }
    for (const oid of knownShallow) {
      if (included.has(oid)) unshallowSet.add(oid);
    }
  } else {
    for (const want of wantCommits) {
      const { commits, boundary } = depthLimitedCommits(repo, want, depth);
      for (const oid of commits) included.add(oid);
      for (const oid of boundary) shallowSet.add(oid);
    }
    // Trees and blobs of the included commits only: walking the full commit closure here
    // would follow parents past the depth cut and defeat the shallow fetch.
    const extra = new Set<string>();
    for (const oid of included) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        const commit = parseCommit(object.data);
        const treeClosure = collectReachable([commit.tree], (entry) => repo.objects.get(entry));
        for (const entry of treeClosure) extra.add(entry);
      }
    }
    for (const oid of extra) included.add(oid);
    for (const oid of knownShallow) {
      if (included.has(oid) && !shallowSet.has(oid)) unshallowSet.add(oid);
    }
  }
  // The tag objects the client asked for travel with the pack (their targets are in
  // wantCommits already when the target is a commit).
  for (const oid of wantTagOids) included.add(oid);
  // Subtract what the client already has. A commit the client holds as a shallow boundary
  // contributes its tree but not its ancestors: the client does not have those, and a
  // deepen must deliver them.
  const haveClosure = collectReachable(haves, (oid) => repo.objects.get(oid), knownShallow);
  for (const oid of haveClosure) included.delete(oid);
  const objects: GitObject[] = [];
  for (const oid of [...included].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  const pack = writePack(objects);

  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'));
  out.push(pktLine('NAK\n'));
  out.push(pktDelim());
  if (shallowSet.size > 0 || unshallowSet.size > 0) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of [...shallowSet].sort()) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of [...unshallowSet].sort()) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(pktDelim());
  }
  out.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) out.push(packet);
  out.push(pktFlush());
  return Buffer.concat(out);
}

function hashOf(object: GitObject): string {
  return hashObject(object.type, object.data);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  // segments: [owner, name.git, service, ...]
  const owner = segments[0] as string;
  const nameWithGit = segments[1] as string;
  if (owner === undefined || nameWithGit === undefined || !nameWithGit.endsWith('.git')) {
    notFound(res);
    return;
  }
  const name = nameWithGit.slice(0, -4);
  const repo = findRepo(owner, name);
  if (repo === null) {
    notFound(res, 'Not Found');
    return;
  }
  const service = segments[2] ?? '';
  const action = query.get('service') ?? '';

  // GET info/refs — segments: [owner, name.git, info, refs]
  if (method === 'GET' && segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs') {
    if (action === 'git-upload-pack') {
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', advertise(repo, 'upload', req.headers['git-protocol'] === 'version=2'));
      return;
    }
    if (action === 'git-receive-pack') {
      sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', advertise(repo, 'receive', false));
      return;
    }
    notFound(res);
    return;
  }

  // POST git-upload-pack (v2 commands, or v0 wants/haves)
  if (method === 'POST' && service === 'git-upload-pack') {
    const raw = await readBody(req);
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (isV2) {
      const { packets } = decodePktLines(raw);
      const command = packets.find((p) => p.kind === 'data' && p.payload !== undefined && p.payload.toString('utf8').startsWith('command='));
      const commandName = command?.payload?.toString('utf8').slice('command='.length).trim() ?? '';
      const args = new Set<string>();
      let refPrefix: string | null = null;
      const wants: string[] = [];
      const haves = new Set<string>();
      let depth: number | null = null;
      for (const packet of packets) {
        if (packet.kind !== 'data' || packet.payload === undefined) continue;
        const line = packet.payload.toString('utf8').trim();
        if (line === 'peel' || line === 'symrefs' || line === 'unborn') args.add(line);
        else if (line.startsWith('ref-prefix ')) refPrefix = line.slice('ref-prefix '.length);
        else if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
        // 'shallow <oid>' lines are the client's known shallow set, not a depth; they are
        // collected separately below.
      }
      if (commandName === 'ls-refs') {
        sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args, refPrefix));
        return;
      }
      if (commandName === 'fetch') {
        // The client's 'shallow <oid>' lines are its known shallow set (for unshallow).
        const shallowArgs = new Set<string>();
        for (const packet of packets) {
          if (packet.kind !== 'data' || packet.payload === undefined) continue;
          const line = packet.payload.toString('utf8').trim();
          if (line.startsWith('shallow ')) shallowArgs.add(line.slice(8).trim());
        }
        sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchPack(repo, wants, haves, depth, shallowArgs));
        return;
      }
      badRequest(res, 'Unknown git-upload-pack command');
      return;
    }
    // v0 fetch: wants section, flush, haves section, flush.
    const { packets } = decodePktLines(raw);
    const wants: string[] = [];
    const haves = new Set<string>();
    let depth: number | null = null;
    let inHaves = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        inHaves = true;
        continue;
      }
      if (packet.kind !== 'data' || packet.payload === undefined) continue;
      const line = packet.payload.toString('utf8').trim();
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      else if (line.startsWith('shallow ')) {
        /* the client's own shallow set; the pack reply re-computes the boundary */
      }
      void inHaves;
    }
    if (wants.length === 0) {
      badRequest(res, 'fetch requires a want line');
      return;
    }
    const knownShallow = new Set<string>();
    for (const packet of packets) {
      if (packet.kind !== 'data' || packet.payload === undefined) continue;
      const line = packet.payload.toString('utf8').trim();
      if (line.startsWith('shallow ')) knownShallow.add(line.slice(8).trim());
    }
    // v0 replies: NAK, shallow/unshallow lines, then the sideband pack (no section headers).
    const v2 = fetchPack(repo, wants, haves, depth, knownShallow);
    const { packets: v2packets } = decodePktLines(v2);
    const out: Buffer[] = [];
    out.push(pktLine('NAK\n'));
    let inShallow = false;
    for (const packet of v2packets) {
      if (packet.kind === 'delim') continue;
      if (packet.kind === 'data' && packet.payload !== undefined) {
        const text = packet.payload.toString('utf8');
        if (text === 'shallow-info\n') {
          inShallow = true;
          continue;
        }
        if (text === 'packfile\n') {
          inShallow = false;
          continue;
        }
        if (inShallow) {
          out.push(pktLine(packet.payload));
          continue;
        }
        if (text === 'acknowledgments\n' || text === 'NAK\n') continue;
        // sideband pack packets pass through unchanged.
        out.push(pktLine(packet.payload));
      }
    }
    out.push(pktFlush());
    sendRaw(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }

  // POST git-receive-pack
  if (method === 'POST' && service === 'git-receive-pack') {
    const raw = await readBody(req);
    const { packets, rest } = decodePktLines(raw);
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data' || packet.payload === undefined) break;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.trim().split(' ');
      if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
        badRequest(res, 'Malformed receive-pack request');
        return;
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    if (commands.length === 0) {
      badRequest(res, 'No commands in receive-pack request');
      return;
    }
    let incoming = new Map<string, GitObject>();
    // A delete-only command list carries no pack at all (git sends none there either).
    if (rest.length > 0) {
      try {
        incoming = readPack(rest);
      } catch {
        badRequest(res, 'Malformed packfile');
        return;
      }
    }
    for (const [oid, object] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    const reportLines: string[] = ['unpack ok\n'];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} reference already exists\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        if (current === undefined || current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} remote ref object does not exist\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref object does not exist\n`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      if (!isAncestor(repo, current, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    }
    const report = Buffer.concat(reportLines.map((line) => pktLine(line)));
    const body = Buffer.concat([...sidebandPackets(report), pktFlush()]);
    sendRaw(res, 200, 'application/x-git-receive-pack-result', body);
    return;
  }

  notFound(res);
}

// --------------------------------------------------------------------------- router + lifecycle

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const segments = pathSegments(url.pathname);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (segments.length === 1 && segments[0] === 'mcp') {
    handleMcp(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error';
      sendJson(res, 500, { message });
    });
    return;
  }

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    handleGraphql(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error';
      sendJson(res, 500, { message });
    });
    return;
  }

  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    handleRest(req, res, segments, url.searchParams).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error';
      sendJson(res, 500, { message });
    });
    return;
  }

  if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
    handleGit(req, res, segments, url.searchParams).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error';
      sendJson(res, 500, { message });
    });
    return;
  }

  // Unknown route: a JSON 404 with the request id (the REST checks hit this too).
  sendJson(res, 404, { message: 'Not Found' });
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url);
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const server: Server = createServer((req, res) => {
    route(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  if (ENV_URL === '') {
    // No harness env: just serve until killed (useful for local testing).
    return;
  }
  const registerUrl = `${ENV_URL}/register`;
  const registerResponse = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!registerResponse.ok) throw new Error(`register failed: ${registerResponse.status}`);

  // Wait until the harness says it is done, then exit 0.
  const doneUrl = `${ENV_URL}/done`;
  for (;;) {
    const done = await fetchJson(doneUrl);
    if (done !== null && done.done === true) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  server.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`github-core-forge: ${message}\n`);
  process.exit(1);
});
