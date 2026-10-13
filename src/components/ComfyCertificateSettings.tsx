import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from './Button';
import { WorkspaceModal } from '../writingUi/WorkspaceModal';
import { comfyApi, type ComfyCertificateApproval, type ComfyCertificateInfo, type ComfyConnectionResult } from '../services/comfy';
import { beginComfyTrustMutation, canApproveComfyCertificate, ComfyRequestScope, formatComfyFingerprint, parseComfyEndpoint, suggestComfyHttps } from '../comfy/settings';
import { tx } from '@utils/i18n';
import type { UiLanguage } from '@typings/index';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateText(value: number, language: UiLanguage): string {
  if (!Number.isFinite(value)) return tx(language, '无效日期', 'Invalid date');
  return new Date(value).toLocaleString(language === 'en' ? 'en-GB' : 'zh-CN');
}

export function ComfyCertificateSettings({
  baseUrl, appliedUrl, uiLanguage, onChangeUrl, onApply, onMutationBusy,
}: {
  baseUrl: string;
  appliedUrl: string;
  uiLanguage: UiLanguage;
  onChangeUrl: (url: string) => void;
  onApply: (url: string) => void;
  onMutationBusy: (busy: boolean) => void;
}) {
  const endpoint = parseComfyEndpoint(baseUrl);
  const addressKey = endpoint?.normalizedUrl ?? `invalid:${baseUrl}`;
  const httpsUrl = endpoint?.isHttps ? endpoint.normalizedUrl : null;
  const actionScope = useRef(new ComfyRequestScope());
  const statusScope = useRef(new ComfyRequestScope());
  actionScope.current.update(addressKey);
  statusScope.current.update(addressKey);
  const [approval, setApproval] = useState<ComfyCertificateApproval | null>(null);
  const [certificate, setCertificate] = useState<ComfyCertificateInfo | null>(null);
  const [fingerprintVerified, setFingerprintVerified] = useState(false);
  const [busy, setBusy] = useState<'inspect' | 'approve' | 'revoke' | 'test' | null>(null);
  const [readError, setReadError] = useState('');
  const [message, setMessage] = useState('');
  const [diagnosis, setDiagnosis] = useState<ComfyConnectionResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const mutationCallback = useRef(onMutationBusy);
  mutationCallback.current = onMutationBusy;

  useEffect(() => () => {
    actionScope.current.invalidate();
    statusScope.current.invalidate();
    mutationCallback.current(false);
  }, []);

  useEffect(() => {
    setCertificate(null);
    setFingerprintVerified(false);
    setBusy(null);
    setMessage('');
    setDiagnosis(null);
  }, [addressKey]);

  useEffect(() => {
    setApproval(null);
    setReadError('');
    if (!httpsUrl) return;
    const scope = statusScope.current;
    const token = scope.begin();
    // Typing does not persist or synchronously read the certificate store.
    const timer = window.setTimeout(() => {
      void comfyApi.getApproval(httpsUrl).then(result => {
        if (scope.isCurrent(token)) {
          if (result && result.origin !== parseComfyEndpoint(httpsUrl)?.origin) {
            setReadError('证书授权范围与当前地址不符。(Approval scope does not match the current origin.)');
          } else setApproval(result);
        }
      }).catch(error => {
        if (scope.isCurrent(token)) setReadError(errorText(error));
      });
    }, 250);
    return () => { window.clearTimeout(timer); scope.invalidate(); };
  }, [httpsUrl, revision]); // The normalized address is the complete request identity.

  useEffect(() => {
    if (!certificate) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [certificate]);

  const inspect = async () => {
    if (!endpoint?.isHttps || busy) return;
    const token = actionScope.current.begin();
    setBusy('inspect'); setMessage(''); setFingerprintVerified(false);
    try {
      const result = await comfyApi.inspect(endpoint.normalizedUrl);
      if (actionScope.current.isCurrent(token)) {
        if (result.origin === endpoint.origin) setCertificate(result);
        else setMessage(tx(uiLanguage, '服务器返回的证书范围与当前地址不符，已阻止授权。', 'The certificate scope does not match the current origin. Approval was blocked.'));
      }
    } catch (error) {
      if (actionScope.current.isCurrent(token)) setMessage(errorText(error));
    } finally {
      if (actionScope.current.isCurrent(token)) setBusy(null);
    }
  };

  const approve = async () => {
    if (busy || !certificate || !canApproveComfyCertificate(endpoint, certificate, fingerprintVerified)) return;
    const token = beginComfyTrustMutation(actionScope.current, statusScope.current);
    setBusy('approve'); mutationCallback.current(true); setMessage('');
    try {
      await comfyApi.approve(endpoint!.normalizedUrl, certificate, fingerprintVerified);
      if (actionScope.current.isCurrent(token)) {
        setCertificate(null); setFingerprintVerified(false); setRevision(value => value + 1);
        setDiagnosis(null);
        setMessage(tx(uiLanguage, '已在本机授权该主机和端口。请重新测试连接；尚未应用的地址仍需点击“应用图片设置”。', 'Approved only for this host and port on this computer. Test again; an unsaved URL still needs Apply image settings.'));
      }
    } catch (error) {
      if (actionScope.current.isCurrent(token)) setMessage(errorText(error));
    } finally {
      mutationCallback.current(false);
      if (actionScope.current.isCurrent(token)) setBusy(null);
    }
  };

  const revoke = async () => {
    if (!endpoint?.isHttps || busy) return;
    const token = beginComfyTrustMutation(actionScope.current, statusScope.current);
    setBusy('revoke'); mutationCallback.current(true); setMessage('');
    try {
      await comfyApi.revoke(endpoint.normalizedUrl);
      if (actionScope.current.isCurrent(token)) {
        setApproval(null); setCertificate(null); setFingerprintVerified(false);
        setDiagnosis(null); setRevision(value => value + 1);
        setMessage(tx(uiLanguage, '授权已撤销。后续连接恢复系统证书校验；需要自签名证书时必须重新核对并授权。', 'Approval revoked. New connections use normal system certificate verification; self-signed certificates need fresh verification and approval.'));
      }
    } catch (error) {
      if (actionScope.current.isCurrent(token)) {
        const text = errorText(error);
        if (text.includes('COMFY_REVOKE_NOT_DURABLE:')) {
          setApproval(null); setCertificate(null); setFingerprintVerified(false); setDiagnosis(null);
          setRevision(value => value + 1);
          setMessage(tx(uiLanguage, '本进程已停止使用证书授权，但未能保存撤销。请点击“撤销本机授权”重试；重启后可能恢复旧授权。', 'Approval is blocked in this running process, but revocation could not be saved. Retry Revoke local approval; restarting may restore the old approval.'));
        } else setMessage(text);
      }
    } finally {
      mutationCallback.current(false);
      if (actionScope.current.isCurrent(token)) setBusy(null);
    }
  };

  const test = async () => {
    if (!endpoint || busy) return;
    const token = actionScope.current.begin();
    setBusy('test'); setMessage(''); setDiagnosis(null);
    try {
      const result = await comfyApi.diagnose(endpoint.normalizedUrl);
      if (actionScope.current.isCurrent(token)) setDiagnosis(result);
    } catch (error) {
      if (actionScope.current.isCurrent(token)) setMessage(errorText(error));
    } finally {
      if (actionScope.current.isCurrent(token)) setBusy(null);
    }
  };

  const httpsSuggestion = suggestComfyHttps(baseUrl);
  const appliedEndpoint = parseComfyEndpoint(appliedUrl);
  const unsaved = endpoint?.normalizedUrl !== appliedEndpoint?.normalizedUrl;
  const validCertificate = canApproveComfyCertificate(endpoint, certificate, true, clock);
  const visibleApproval = approval?.origin === endpoint?.origin ? approval : null;

  return (
    <div className="space-y-3 text-sm">
      {!endpoint && <p role="alert" className="text-red-600 dark:text-red-400">{tx(uiLanguage, '请填写有效的 HTTP/HTTPS 地址或主机:端口，可保留反向代理路径，但不能包含登录凭据、查询参数、空白或 # 片段。', 'Enter an HTTP/HTTPS URL or host:port. A proxy path is allowed; credentials, query, whitespace and fragments are not.')}</p>}
      <div className="flex flex-wrap gap-2 items-center">
        <Button type="button" variant="outline" disabled={!endpoint || !!busy} onClick={() => {
          if (!endpoint) return;
          onApply(endpoint.normalizedUrl);
          setMessage(tx(uiLanguage, '图片引擎和地址已应用；文本模型及其他设置未修改。', 'Image engine and URL applied; text models and other settings were not changed.'));
        }}>{tx(uiLanguage, '应用图片设置', 'Apply image settings')}</Button>
        <Button type="button" onClick={() => void test()} disabled={!endpoint || !!busy} loading={busy === 'test'}>{tx(uiLanguage, '测试 ComfyUI 连接', 'Test ComfyUI connection')}</Button>
      </div>
      <p className="text-gray-600 dark:text-gray-400 break-all">{tx(uiLanguage, '生成图片使用的已保存地址：', 'Saved URL used for image generation: ')}{appliedUrl}</p>
      {unsaved && <p className="text-amber-700 dark:text-amber-300">{tx(uiLanguage, '当前输入尚未应用。连接测试和证书操作使用当前输入；生成图片仍使用上面的已保存地址。', 'This draft is not applied. Tests and certificate actions use the draft; image generation still uses the saved URL above.')}</p>}
      {httpsSuggestion && <div className="space-y-2">
        <p className="text-gray-600 dark:text-gray-400">{tx(uiLanguage, '启用了自动 HTTPS 的公网隧道必须使用 HTTPS。HTTP 地址不会获得证书授权。', 'Public tunnels with automatic HTTPS require HTTPS. HTTP addresses cannot receive certificate approval.')}</p>
        <Button type="button" variant="outline" disabled={!!busy} onClick={() => onChangeUrl(httpsSuggestion)}>{tx(uiLanguage, '切换 HTTPS 并核对隧道证书', 'Switch to HTTPS and verify tunnel certificate')}</Button>
      </div>}
      {endpoint?.isHttps && <div className="border rounded-lg p-3 space-y-2 dark:border-gray-600">
        <div className="flex gap-2 items-center font-medium"><ShieldCheck className="h-4 w-4 shrink-0" />{tx(uiLanguage, '本机服务器证书授权', 'Server certificate approval on this computer')}</div>
        <p className="break-all">{tx(uiLanguage, '仅限：', 'Scope: ')}{endpoint.origin}</p>
        <p className="text-gray-600 dark:text-gray-400">{tx(uiLanguage, '保留域名、证书有效期和完整指纹校验；不关闭 HTTPS 安全检查，不安装系统证书。授权不随书库备份或跨设备导入。', 'Hostname, validity and exact fingerprint checks stay enabled. No global HTTPS bypass or system certificate installation. Approval is excluded from library backups and cross-device imports.')}</p>
        {visibleApproval ? <div>
          <p className="text-green-700 dark:text-green-400">{tx(uiLanguage, '已在本机绑定 SHA-256：', 'SHA-256 approved locally:')}</p>
          <p className="font-mono break-all select-all">{formatComfyFingerprint(visibleApproval.certificateSha256)}</p>
        </div> : <p className="text-gray-600 dark:text-gray-400">{tx(uiLanguage, '未在本机授权此地址，使用系统证书校验。', 'No local approval for this address; normal system certificate verification applies.')}</p>}
        {readError && <p role="alert" className="text-red-600 dark:text-red-400">{readError}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!!busy} loading={busy === 'inspect'} onClick={() => void inspect()}>{tx(uiLanguage, '查看并核对服务器证书', 'Inspect and verify server certificate')}</Button>
          <Button type="button" variant="outline" disabled={!!busy} loading={busy === 'revoke'} onClick={() => void revoke()}>{tx(uiLanguage, '撤销本机授权', 'Revoke local approval')}</Button>
        </div>
      </div>}
      {diagnosis && <div role="status" className={diagnosis.success ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
        <p>{diagnosis.message}</p>
        {diagnosis.suggestedUrl && parseComfyEndpoint(diagnosis.suggestedUrl)?.isHttps && <Button type="button" className="mt-2" variant="outline" disabled={!!busy} onClick={() => onChangeUrl(diagnosis.suggestedUrl!)}>{tx(uiLanguage, '使用建议的 HTTPS 地址', 'Use suggested HTTPS URL')}</Button>}
      </div>}
      {message && <p role="status" className="text-amber-700 dark:text-amber-300 break-words">{message}</p>}
      {certificate && certificate.origin === endpoint?.origin && <WorkspaceModal title={tx(uiLanguage, '核对 ComfyUI 服务器证书', 'Verify ComfyUI server certificate')} busy={busy === 'approve'} onClose={() => { setCertificate(null); setFingerprintVerified(false); }} footer={
        <div className="flex flex-wrap justify-end gap-3">
          <Button type="button" variant="outline" disabled={busy === 'approve'} onClick={() => { setCertificate(null); setFingerprintVerified(false); }}>{tx(uiLanguage, '取消', 'Cancel')}</Button>
          <Button type="button" disabled={!!busy || !canApproveComfyCertificate(endpoint, certificate, fingerprintVerified, clock)} loading={busy === 'approve'} onClick={() => void approve()}>{tx(uiLanguage, '仅授权此主机和端口', 'Approve only this host and port')}</Button>
        </div>
      }>
        <div className="space-y-4 max-w-3xl mx-auto">
          <p className="text-amber-700 dark:text-amber-300">{tx(uiLanguage, '当前看到的证书并不能自行证明服务器身份。请在运行隧道的电脑上，从自己的证书文件独立获取完整 SHA-256 指纹，并逐字核对。不要因为连接失败就信任陌生证书；证书更新后必须重新核验。', 'The observed certificate does not itself prove the server identity. Independently obtain the complete SHA-256 fingerprint from your own certificate file on the tunnel computer and compare every character. Do not trust an unknown certificate just to fix a connection. Re-verify when the certificate changes.')}</p>
          <p className="break-all"><strong>{tx(uiLanguage, '授权范围：', 'Approval scope: ')}</strong>{certificate.origin}</p>
          <div>
            <label htmlFor="comfy-certificate-fingerprint" className="block font-medium mb-1">SHA-256</label>
            <textarea id="comfy-certificate-fingerprint" readOnly rows={3} value={formatComfyFingerprint(certificate.certificateSha256)} className="w-full font-mono text-sm border rounded-lg p-3 dark:bg-gray-800 dark:border-gray-600 select-all" onFocus={event => event.currentTarget.select()} />
            <p className="text-xs text-gray-500">{tx(uiLanguage, '点击指纹可全选并复制；必须核对完整 32 组字符。', 'Select the fingerprint to copy; compare all 32 byte pairs.')}</p>
          </div>
          <dl className="space-y-2 break-words">
            <div><dt className="font-medium">{tx(uiLanguage, '主题', 'Subject')}</dt><dd>{certificate.subject}</dd></div>
            <div><dt className="font-medium">{tx(uiLanguage, '签发者', 'Issuer')}</dt><dd>{certificate.issuer}</dd></div>
            <div><dt className="font-medium">{tx(uiLanguage, '有效期（本地时间）', 'Validity (local time)')}</dt><dd>{dateText(certificate.notBeforeEpochMs, uiLanguage)} — {dateText(certificate.notAfterEpochMs, uiLanguage)}</dd></div>
          </dl>
          {!validCertificate && <p role="alert" className="text-red-600 dark:text-red-400">{tx(uiLanguage, '证书尚未生效、已过期或与当前地址不符，无法授权。', 'The certificate is not yet valid, expired, or does not match the current origin; approval is blocked.')}</p>}
          <label className="flex gap-3 items-start cursor-pointer">
            <input type="checkbox" checked={fingerprintVerified} disabled={!!busy || !validCertificate} onChange={event => setFingerprintVerified(event.target.checked)} className="mt-1 h-4 w-4" />
            <span>{tx(uiLanguage, '我已独立核对完整指纹，确认这是我的服务器。', 'I independently verified the complete fingerprint and confirmed this is my server.')}</span>
          </label>
          {message && <p role="alert" className="text-red-600 dark:text-red-400">{message}</p>}
        </div>
      </WorkspaceModal>}
    </div>
  );
}
