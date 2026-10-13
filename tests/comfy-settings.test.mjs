import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/comfy/settings.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
});
const helpers = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

test('Comfy draft URL keeps the public tunnel port and reverse proxy prefix', () => {
  assert.deepEqual(helpers.parseComfyEndpoint('  tunnel.example:35961/comfy  '), {
    normalizedUrl: 'http://tunnel.example:35961/comfy', origin: 'http://tunnel.example:35961', isHttps: false,
  });
  assert.deepEqual(helpers.parseComfyEndpoint('HTTPS://Tunnel.Example:35961/comfy/'), {
    normalizedUrl: 'https://tunnel.example:35961/comfy', origin: 'https://tunnel.example:35961', isHttps: true,
  });
  assert.equal(helpers.parseComfyEndpoint('http://localhost:8188').normalizedUrl, 'http://localhost:8188');
});

test('invalid and credential-bearing Comfy addresses fail closed without render exceptions', () => {
  for (const value of ['', ' ', 'ftp://tunnel.example', 'https://u:p@tunnel.example',
    'https://@tunnel.example', 'https://tunnel.example?a=1', 'https://tunnel.example?',
    'https://tunnel.example#fragment', 'https://tunnel.example#', 'http://tunnel.example:70000',
    'http://tunnel.example:0', 'https://tunnel.example:0/comfy',
    'http://tunnel.example/a b', 'http://tunnel.example\\evil', 'https://tunnel.example/\u0000']) {
    assert.equal(helpers.parseComfyEndpoint(value), null, value);
    assert.equal(helpers.suggestComfyHttps(value), null, value);
  }
});

test('explicit HTTPS switch preserves a tunnel port, including an explicitly selected HTTP :80', () => {
  assert.equal(helpers.suggestComfyHttps('tunnel.example:35961/comfy'), 'https://tunnel.example:35961/comfy');
  assert.equal(helpers.suggestComfyHttps('http://tunnel.example:80/comfy/'), 'https://tunnel.example:80/comfy');
  assert.equal(helpers.suggestComfyHttps('https://tunnel.example:35961'), null);
  assert.equal(helpers.parseComfyEndpoint(helpers.suggestComfyHttps('http://[::1]:8188/proxy')).origin, 'https://[::1]:8188');
});

test('SHA-256 preview preserves the entire fingerprint for independent comparison', () => {
  const raw = '0123456789abcdef'.repeat(4);
  const display = helpers.formatComfyFingerprint(raw);
  assert.equal(display.split(':').length, 32);
  assert.equal(display.replaceAll(':', '').toLowerCase(), raw);
  assert.equal(helpers.formatComfyFingerprint('not-a-fingerprint'), 'not-a-fingerprint');
});

const endpoint = helpers.parseComfyEndpoint('https://tunnel.example:35961/comfy');
const certificate = { origin: endpoint.origin, certificateSha256: 'ab'.repeat(32), notBeforeEpochMs: 100, notAfterEpochMs: 200 };

test('approval requires an explicitly checked fingerprint and a valid certificate', () => {
  assert.equal(helpers.canApproveComfyCertificate(endpoint, certificate, false, 150), false);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, certificate, true, 150), true);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, certificate, true, 99), false);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, certificate, true, 200), false);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, { ...certificate, certificateSha256: 'ab' }, true, 150), false);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, { ...certificate, notAfterEpochMs: NaN }, true, 150), false);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, certificate, true, NaN), false);
  assert.equal(helpers.canApproveComfyCertificate(endpoint, null, true, 150), false);
});

test('approval cannot cross a host, port, protocol or invalid address', () => {
  for (const address of ['https://other.example:35961/comfy', 'https://tunnel.example:35962/comfy', 'http://tunnel.example:35961/comfy', 'invalid://address']) {
    assert.equal(helpers.canApproveComfyCertificate(helpers.parseComfyEndpoint(address), certificate, true, 150), false, address);
  }
  // Proxy path does not broaden certificate identity beyond this exact origin.
  assert.equal(helpers.canApproveComfyCertificate(helpers.parseComfyEndpoint('https://tunnel.example:35961/other'), certificate, true, 150), true);
});

test('old test and inspection responses cannot update a newly edited Comfy URL', () => {
  const scope = new helpers.ComfyRequestScope();
  scope.update('https://first.example:35961/comfy');
  const first = scope.begin();
  assert.equal(scope.isCurrent(first), true);
  scope.update('https://second.example:35961/comfy');
  assert.equal(scope.isCurrent(first), false);
  scope.update('https://first.example:35961/comfy');
  assert.equal(scope.isCurrent(first), false, 'switching back must not revive an old response');
  const latest = scope.begin();
  scope.invalidate();
  assert.equal(scope.isCurrent(latest), false, 'unmount/cleanup invalidates pending work');
});

test('a replaced request is stale even when the address stays identical', () => {
  const scope = new helpers.ComfyRequestScope();
  scope.update('https://tunnel.example:35961');
  const previous = scope.begin(), latest = scope.begin();
  assert.equal(scope.isCurrent(previous), false);
  assert.equal(scope.isCurrent(latest), true);
  scope.update('https://tunnel.example:35961');
  assert.equal(scope.isCurrent(latest), true);
});

test('approval and revocation immediately fence older approval reads for the same origin', async () => {
  for (const operation of ['approve', 'revoke']) {
    const actionScope = new helpers.ComfyRequestScope(), statusScope = new helpers.ComfyRequestScope();
    actionScope.update(endpoint.normalizedUrl); statusScope.update(endpoint.normalizedUrl);
    const oldRead = statusScope.begin();
    let resolveRead;
    let visibleApproval = null;
    const pendingRead = new Promise(resolve => { resolveRead = resolve; }).then(value => {
      if (statusScope.isCurrent(oldRead)) visibleApproval = value;
    });
    const mutation = helpers.beginComfyTrustMutation(actionScope, statusScope);
    assert.equal(actionScope.isCurrent(mutation), true, operation);
    assert.equal(statusScope.isCurrent(oldRead), false, operation);
    resolveRead(certificate);
    await pendingRead;
    assert.equal(visibleApproval, null, `${operation} must not show a late old approval`);
  }
});

test('failed durable revocation refreshes the denied native state without reviving a late grant', async () => {
  const actionScope = new helpers.ComfyRequestScope(), statusScope = new helpers.ComfyRequestScope();
  actionScope.update(endpoint.normalizedUrl); statusScope.update(endpoint.normalizedUrl);
  const oldRead = statusScope.begin();
  let resolveOldRead;
  let visibleApproval = certificate;
  let message = '';
  const pendingOldRead = new Promise(resolve => { resolveOldRead = resolve; }).then(value => {
    if (statusScope.isCurrent(oldRead)) visibleApproval = value;
  });
  const mutation = helpers.beginComfyTrustMutation(actionScope, statusScope);
  // Native revocation has already blocked this process even though saving the denial failed.
  const nativeError = new Error('COMFY_REVOKE_NOT_DURABLE: disk unavailable');
  if (actionScope.isCurrent(mutation) && nativeError.message.includes('COMFY_REVOKE_NOT_DURABLE:')) {
    visibleApproval = null;
    message = 'Approval is blocked in this running process; restarting may restore the old approval.';
    const refreshedRead = statusScope.begin();
    const deniedApproval = await Promise.resolve(null);
    if (statusScope.isCurrent(refreshedRead)) visibleApproval = deniedApproval;
  }
  resolveOldRead(certificate);
  await pendingOldRead;
  assert.equal(visibleApproval, null);
  assert.match(message, /restarting may restore the old approval/);
});

const nativeCalls = [];
globalThis.__comfyNativeCalls = nativeCalls;
const nativeBuild = await build({
  entryPoints: [fileURLToPath(new URL('../src/services/comfy.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
  plugins: [{ name: 'native-comfy-mock', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/api\/tauri$/ }, args => ({ path: args.path, namespace: 'native-mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'native-mock' }, () => ({
      contents: 'export async function invoke(command,args){globalThis.__comfyNativeCalls.push({command,args});return null;}', loader: 'js',
    }));
  } }],
});
const { comfyApi } = await import(`data:text/javascript;base64,${Buffer.from(nativeBuild.outputFiles[0].text).toString('base64')}`);

test('certificate authority stays native-only with an explicit fingerprint confirmation argument', async () => {
  const url = endpoint.normalizedUrl;
  await comfyApi.getApproval(url);
  await comfyApi.inspect(url);
  await comfyApi.approve(url, certificate, true);
  await comfyApi.revoke(url);
  await comfyApi.diagnose(url);
  assert.deepEqual(nativeCalls, [
    { command: 'comfy_get_certificate_approval', args: { baseUrl: url } },
    { command: 'comfy_inspect_certificate', args: { baseUrl: url } },
    { command: 'comfy_approve_certificate', args: { baseUrl: url, certificate, fingerprintVerified: true } },
    { command: 'comfy_revoke_certificate', args: { baseUrl: url } },
    { command: 'diagnose_comfyui_connection', args: { comfyuiUrl: url } },
  ]);
});

const require = createRequire(import.meta.url);
globalThis.__comfyReactRuntimeModules = Object.fromEntries(['react', 'react-dom', 'react/jsx-runtime'].map(name => [name, require(name)]));
const componentBuild = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/ComfyCertificateSettings.tsx', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', target: 'node20', write: false,
  plugins: [{ name: 'comfy-render-native-isolation', setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => args.kind === 'require-call'
      ? { path: args.path, namespace: 'react-render-shim' }
      : { path: pathToFileURL(require.resolve(args.path)).href, external: true });
    builder.onLoad({ filter: /.*/, namespace: 'react-render-shim' }, args => ({ contents: `module.exports=globalThis.__comfyReactRuntimeModules[${JSON.stringify(args.path)}];`, loader: 'js' }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/tauri$/ }, args => ({ path: args.path, namespace: 'render-native-mock' }));
    builder.onLoad({ filter: /.*/, namespace: 'render-native-mock' }, () => ({
      contents: 'export async function invoke(){throw new Error("render must not read or grant native certificate authority");}', loader: 'js',
    }));
  } }],
});
const { ComfyCertificateSettings } = await import(`data:text/javascript;base64,${Buffer.from(componentBuild.outputFiles[0].text).toString('base64')}`);
const renderPanel = (baseUrl, appliedUrl = 'http://localhost:8188') => renderToStaticMarkup(createElement(ComfyCertificateSettings, {
  baseUrl, appliedUrl, uiLanguage: 'en', onChangeUrl() {}, onApply() {}, onMutationBusy() {},
}));

test('actual HTTPS settings panel distinguishes draft tests from the saved generation URL', () => {
  const html = renderPanel('https://tunnel.example:35961/comfy');
  assert.match(html, /Tests and certificate actions use the draft/);
  assert.match(html, /image generation still uses the saved URL/);
  assert.match(html, /http:\/\/localhost:8188/);
  assert.match(html, /https:\/\/tunnel.example:35961/);
  assert.match(html, /No local approval for this address/);
  assert.match(html, /excluded from library backups and cross-device imports/);
  assert.match(html, /Inspect and verify server certificate/);
  assert.match(html, /Revoke local approval/);
});

test('HTTP settings cannot offer certificate approval until an explicit HTTPS switch', () => {
  const html = renderPanel('tunnel.example:35961/comfy');
  assert.match(html, /Switch to HTTPS and verify tunnel certificate/);
  assert.doesNotMatch(html, /Inspect and verify server certificate/);
  assert.doesNotMatch(html, /Revoke local approval/);
});

test('invalid settings render a useful error and disable apply/test without touching native storage', () => {
  const html = renderPanel('https://password:secret@tunnel.example');
  assert.match(html, /credentials, query, whitespace and fragments are not/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Apply image settings<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Test ComfyUI connection<\/button>/);
});
