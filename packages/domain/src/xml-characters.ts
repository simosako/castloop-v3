/** XML 1.0 characters, including rejection of unpaired UTF-16 surrogates. */
export function hasInvalidXmlCharacters(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(value);
}
