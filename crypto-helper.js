/**
 * CryptoHelper - A pure, zero-dependency cryptographic utility for the decentralized Tippspiel
 * Using the browser-native Web Crypto API (ECDSA P-256 for signatures, SHA-256 for hashes).
 */

export class CryptoHelper {
  /**
   * Generates a new ECDSA P-256 key pair.
   * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey}>}
   */
  static async generateKeyPair() {
    return await window.crypto.subtle.generateKey(
      {
        name: "ECDSA",
        namedCurve: "P-256"
      },
      true, // extractable
      ["sign", "verify"]
    );
  }

  /**
   * Exports a CryptoKey (Public) to a base64 string (SPKI format).
   * @param {CryptoKey} publicKey 
   * @returns {Promise<string>}
   */
  static async exportPublicKey(publicKey) {
    const exported = await window.crypto.subtle.exportKey("spki", publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }

  /**
   * Imports a base64 string (SPKI format) back into a CryptoKey (Public).
   * @param {string} base64Str 
   * @returns {Promise<CryptoKey>}
   */
  static async importPublicKey(base64Str) {
    const binaryStr = atob(base64Str);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return await window.crypto.subtle.importKey(
      "spki",
      bytes.buffer,
      {
        name: "ECDSA",
        namedCurve: "P-256"
      },
      true,
      ["verify"]
    );
  }

  /**
   * Exports a CryptoKey (Private) to a base64 string (PKCS8 format).
   * @param {CryptoKey} privateKey 
   * @returns {Promise<string>}
   */
  static async exportPrivateKey(privateKey) {
    const exported = await window.crypto.subtle.exportKey("pkcs8", privateKey);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
  }

  /**
   * Imports a base64 string (PKCS8 format) back into a CryptoKey (Private).
   * @param {string} base64Str 
   * @returns {Promise<CryptoKey>}
   */
  static async importPrivateKey(base64Str) {
    const binaryStr = atob(base64Str);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return await window.crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      {
        name: "ECDSA",
        namedCurve: "P-256"
      },
      true,
      ["sign"]
    );
  }

  /**
   * Signs string data or an object using ECDSA P-256 private key.
   * @param {CryptoKey} privateKey 
   * @param {string|object} data 
   * @returns {Promise<string>} Signature as base64
   */
  static async signData(privateKey, data) {
    const dataStr = typeof data === "object" ? JSON.stringify(data) : data;
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(dataStr);
    const signatureBuffer = await window.crypto.subtle.sign(
      {
        name: "ECDSA",
        hash: { name: "SHA-256" }
      },
      privateKey,
      dataBytes
    );
    return btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  }

  /**
   * Verifies an ECDSA signature of string data/object using public key.
   * @param {CryptoKey|string} publicKeyOrBase64 CryptoKey or exported public key base64 string
   * @param {string} signatureBase64 
   * @param {string|object} data 
   * @returns {Promise<boolean>} True if valid, false otherwise
   */
  static async verifySignature(publicKeyOrBase64, signatureBase64, data) {
    try {
      let publicKey;
      if (typeof publicKeyOrBase64 === "string") {
        publicKey = await this.importPublicKey(publicKeyOrBase64);
      } else {
        publicKey = publicKeyOrBase64;
      }

      const dataStr = typeof data === "object" ? JSON.stringify(data) : data;
      const encoder = new TextEncoder();
      const dataBytes = encoder.encode(dataStr);

      const binarySig = atob(signatureBase64);
      const sigBytes = new Uint8Array(binarySig.length);
      for (let i = 0; i < binarySig.length; i++) {
        sigBytes[i] = binarySig.charCodeAt(i);
      }

      return await window.crypto.subtle.verify(
        {
          name: "ECDSA",
          hash: { name: "SHA-256" }
        },
        publicKey,
        sigBytes.buffer,
        dataBytes
      );
    } catch (e) {
      console.error("Signature verification error:", e);
      return false;
    }
  }

  /**
   * Computes SHA-256 hex hash of any data/object.
   * @param {string|object} data 
   * @returns {Promise<string>} SHA-256 hex hash
   */
  static async hashData(data) {
    const dataStr = typeof data === "object" ? JSON.stringify(data) : data;
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(dataStr);
    const hashBuffer = await window.crypto.subtle.digest("SHA-256", dataBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
