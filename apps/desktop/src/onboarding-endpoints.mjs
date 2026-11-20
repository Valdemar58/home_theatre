// Keep desktop bootstrap requests aligned with the existing server API.
export const onboardingEndpoints=Object.freeze({
  "setup-status":{path:"/api/auth/status",method:"GET"},
  "setup-me":{path:"/api/me",method:"GET"},
  "setup-lists":{path:"/api/list",method:"GET"},
  "setup-import":{path:"/api/shikimori/sync",method:"POST"},
});
