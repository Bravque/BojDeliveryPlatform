/**
 * Kenyan phone-number normalization to E.164 (decision D8).
 *
 * Accepts the common local/international spellings and returns a canonical `+2547XXXXXXXX` /
 * `+2541XXXXXXXX`, or `null` if the input is not a valid Kenyan mobile number. Normalization is
 * the only sanctioned way to turn user input into the stored identity — callers must reject
 * `null` rather than storing raw input.
 */
export function normalizeKenyanPhone(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  let s = input.trim().replace(/[\s()-]/g, '');
  let hadPlus = false;
  if (s.startsWith('+')) {
    hadPlus = true;
    s = s.slice(1);
  }
  if (!/^\d+$/.test(s)) {
    return null;
  }

  let national: string;
  if (s.startsWith('254')) {
    national = s.slice(3);
  } else if (!hadPlus && s.startsWith('0')) {
    national = s.slice(1);
  } else if (!hadPlus) {
    national = s; // bare subscriber number, e.g. 712345678
  } else {
    return null; // had a leading + but not the Kenyan country code
  }

  // Kenyan mobile subscriber numbers are 9 digits starting with 7 or 1.
  if (!/^[71]\d{8}$/.test(national)) {
    return null;
  }
  return `+254${national}`;
}
