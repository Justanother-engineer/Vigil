// /home/jae/QWEN/patterns.js
export const maliciousPatterns = [
  // --- PowerShell Specific ---
  // Most specific for the reported case: "powershell -E <base64>"
  // Removed 's' flag.
  /\bpowershell\s+-E\s+[A-Za-z0-9+/=]{20,}/i,

  // General "powershell -E" (should catch your specific string)
  /\bpowershell\s+-E\b/i,

  // General "powershell" or "pwsh" followed by various encoded command flags.
  // Using non-greedy .*? and word boundaries for flags.
  /\b(powershell|pwsh)(\.exe)?\b.*?\s+(-e|-en|-enc|-encodedc|-encodedcommand)\b/i,

  // General powershell (whole word, case-insensitive) - Good fallback
  /\bpowershell\b/i,

  // --- Other Command Injection Patterns ---
  /iex\s*\(new-object net.webclient\)\.downloadstring/i,
  /curl\s*-sL/i,
  /bash\s*-c/i,
  // Non-greedy .*? and word boundaries.
  /\b(iex|invoke-expression|iwr|invoke-webrequest)\b.*?\(/i,
  // Non-greedy .*?
  /(curl|wget)\s+.*?\s+\|\s+(bash|sh|zsh|powershell|pwsh)/i,
  /mshta\.exe\s+(vbscript|javascript|http:|https:)/i,
  // Non-greedy .*? and word boundaries.
  /\b(bitsadmin|certutil)\b.*?(\/transfer|\/urlcache)\b/i,
  /rundll32\.exe\s+javascript:/i,
  // Using non-greedy .*? and word boundaries.
  /cmd\s*\/c\s*start\s*\/min\s*powershell\b.*?\b(invoke-webrequest|iwr)\b.*?-outfile\b.*?\bstart-process\b/i,
  /\bmshta(\.exe)?\s+(https?|hxxps?):\/\/[^\s"']+/i,
  /\bI\s*am\s*not\s*a\s*robot\s*:\s*CAPTCHA\s*Verification\b/i,
  /\bmshta(\.exe)?\s+["“](https?|hxxps?):\/\/[^\s"”]+["”]/i
];
