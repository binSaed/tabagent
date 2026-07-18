// A minimal manifest type so build.mjs / manifest.ts typecheck without depending
// on @types/chrome's chrome.runtime.Manifest (which differs across MV3 versions).
export interface Manifest {
  manifest_version: 3;
  name: string;
  version: string;
  description?: string;
  minimum_chrome_version?: string;
  background: { service_worker: string };
  action: {
    default_title?: string;
    default_popup: string;
    default_icon?: Record<string, string>;
  };
  icons?: Record<string, string>;
  side_panel: { default_path: string };
  permissions: string[];
  optional_permissions?: string[];
  optional_host_permissions?: string[];
  host_permissions: string[];
  content_security_policy: { extension_pages: string };
  web_accessible_resources: { resources: string[]; matches: string[] }[];
  content_scripts?: Array<{
    matches: string[];
    js?: string[];
    css?: string[];
    run_at?: "document_start" | "document_end" | "document_idle";
    all_frames?: boolean;
  }>;
  commands?: Record<string, {
    suggested_key?: { default?: string; mac?: string };
    description?: string;
  }>;
}
