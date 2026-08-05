// Unicode homoglyph normalization for OCR output.
//
// This fixes a REAL, REPRODUCED bug. Apple Vision, OCRing a synthetic invoice
// header, returned:
//
//   text:       "AСME TRADING LTD"
//   codepoints: A U+0041   С U+0421   M U+004D   E U+0045
//
// U+0421 is CYRILLIC CAPITAL LETTER ES. It renders identically to Latin C, so
// the vendor name looks perfect on screen while silently failing every string
// comparison forever: it will never match its brain note, never group with its
// other invoices, and never raise an error explaining why.
//
// The mapping is deliberately conditional. Blindly Latinising every Cyrillic
// glyph would corrupt genuinely Russian text, so we only rewrite when the
// string is predominantly Latin already, which is exactly the OCR-confusion
// case and never the real-Cyrillic case.

/** Cyrillic and Greek codepoints that are visually identical to a Latin letter. */
const HOMOGLYPHS: Record<string, string> = {
    // Cyrillic uppercase
    '\u0410': 'A', // А
    '\u0412': 'B', // В
    '\u0415': 'E', // Е
    '\u0417': '3', // З
    '\u041A': 'K', // К
    '\u041C': 'M', // М
    '\u041D': 'H', // Н
    '\u041E': 'O', // О
    '\u0420': 'P', // Р
    '\u0421': 'C', // С  <- the one Vision actually emitted
    '\u0422': 'T', // Т
    '\u0423': 'Y', // У
    '\u0425': 'X', // Х
    '\u0405': 'S', // Ѕ
    '\u0406': 'I', // І
    '\u0408': 'J', // Ј
    // Cyrillic lowercase
    '\u0430': 'a', // а
    '\u0435': 'e', // е
    '\u043E': 'o', // о
    '\u0440': 'p', // р
    '\u0441': 'c', // с
    '\u0443': 'y', // у
    '\u0445': 'x', // х
    '\u0456': 'i', // і
    '\u0458': 'j', // ј
    // Greek uppercase
    '\u0391': 'A', // Α
    '\u0392': 'B', // Β
    '\u0395': 'E', // Ε
    '\u0396': 'Z', // Ζ
    '\u0397': 'H', // Η
    '\u0399': 'I', // Ι
    '\u039A': 'K', // Κ
    '\u039C': 'M', // Μ
    '\u039D': 'N', // Ν
    '\u039F': 'O', // Ο
    '\u03A1': 'P', // Ρ
    '\u03A4': 'T', // Τ
    '\u03A5': 'Y', // Υ
    '\u03A7': 'X', // Χ
    // Greek lowercase that reads as Latin
    '\u03BF': 'o', // ο
    '\u03C1': 'p', // ρ
    '\u03C5': 'u', // υ
};

const LATIN_RE = /[A-Za-z]/;

/** True when `s` contains a homoglyph that would break a string comparison. */
export function hasConfusables(s: string): boolean {
    const text = String(s ?? '');
    if (!text) return false;
    for (const ch of text) {
        if (HOMOGLYPHS[ch]) return true;
    }
    return false;
}

/**
 * Decide whether a string is "mostly Latin". Only then is a homoglyph almost
 * certainly an OCR slip rather than intentional Cyrillic or Greek.
 */
function isPredominantlyLatin(s: string): boolean {
    let latin = 0;
    let foreignNonHomoglyph = 0;
    for (const ch of s) {
        if (LATIN_RE.test(ch)) {
            latin++;
            continue;
        }
        const code = ch.codePointAt(0) ?? 0;
        const isCyrillicOrGreek =
            (code >= 0x0400 && code <= 0x04ff) || (code >= 0x0370 && code <= 0x03ff);
        // A Cyrillic letter WITHOUT a Latin lookalike is strong evidence the
        // text is genuinely Cyrillic. "Москва" trips this on к, в, and м... so
        // count only the ones that are not themselves homoglyphs.
        if (isCyrillicOrGreek && !HOMOGLYPHS[ch]) foreignNonHomoglyph++;
    }
    if (foreignNonHomoglyph > 0) return false;
    return latin > 0;
}

/**
 * NFKC-normalize and, when the string is otherwise Latin, fold homoglyphs to
 * their Latin equivalents. Genuine Cyrillic or Greek text is returned intact.
 */
export function normalizeConfusables(s: string): string {
    const input = String(s ?? '');
    if (!input) return input;
    const normalized = input.normalize('NFKC');
    if (!hasConfusables(normalized)) return normalized;
    if (!isPredominantlyLatin(normalized)) return normalized;
    let out = '';
    for (const ch of normalized) {
        out += HOMOGLYPHS[ch] ?? ch;
    }
    return out;
}

/** Apply normalization across a record, for OCR rows about to become keys. */
export function normalizeRowConfusables(row: string[]): string[] {
    return row.map((cell) => normalizeConfusables(cell));
}
