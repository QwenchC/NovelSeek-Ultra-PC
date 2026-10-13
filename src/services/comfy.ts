import { invoke } from '@tauri-apps/api/tauri';

export interface ComfyCertificateApproval {
  origin: string;
  certificateSha256: string;
}

export interface ComfyCertificateInfo extends ComfyCertificateApproval {
  certificateDerBase64: string;
  subject: string;
  issuer: string;
  notBeforeEpochMs: number;
  notAfterEpochMs: number;
}

export interface ComfyConnectionResult {
  success: boolean;
  message: string;
  normalizedUrl?: string | null;
  suggestedUrl?: string | null;
  certificateInspectionAvailable?: boolean;
}

/** Native, device-local authority. Never store certificate approval in portable app settings. */
export const comfyApi = {
  getApproval: (baseUrl: string) =>
    invoke<ComfyCertificateApproval | null>('comfy_get_certificate_approval', { baseUrl }),
  inspect: (baseUrl: string) =>
    invoke<ComfyCertificateInfo>('comfy_inspect_certificate', { baseUrl }),
  approve: (baseUrl: string, certificate: ComfyCertificateInfo, fingerprintVerified: boolean) =>
    invoke<ComfyCertificateApproval>('comfy_approve_certificate', { baseUrl, certificate, fingerprintVerified }),
  revoke: (baseUrl: string) => invoke<void>('comfy_revoke_certificate', { baseUrl }),
  diagnose: (comfyuiUrl: string) =>
    invoke<ComfyConnectionResult>('diagnose_comfyui_connection', { comfyuiUrl }),
};
