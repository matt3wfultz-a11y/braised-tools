#!/usr/bin/env python3
"""Build and sign the Property Linker ZXP.

    python3 build.py                 # -> dist/PropertyLinker-<version>.zxp
    python3 build.py --key k.pem --cert c.pem    # sign with your own certificate

Needs only Python 3 and the `openssl` command (both ship with macOS).

A ZXP is a zip in Adobe's UCF format: an uncompressed `mimetype` entry first,
the extension's files, and META-INF/signatures.xml - an XML-DSig signature
whose manifest lists a SHA-256 digest of every file. This script writes the
same structure as Adobe's ZXPSignCmd (rsa-sha1 signature over the SignedInfo,
inclusive C14N, sha256 digests), so ZXP installers and ExManCmd accept it.

With no --key/--cert, a self-signed certificate is created once in .signing/
(git-ignored) and reused for later builds - the same kind of certificate
`ZXPSignCmd -selfSignedCert` makes.
"""

import argparse
import base64
import hashlib
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "extension"
DIST = HERE / "dist"
SIGNING = HERE / ".signing"

MIMETYPE = b"application/vnd.adobe.air-ucf-package+zip"
DSIG_NS = "http://www.w3.org/2000/09/xmldsig#"
C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1"
SHA256 = "http://www.w3.org/2001/04/xmlenc#sha256"

# Never packaged (matches ZXPSignCmd).
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
# Package paths go into XML attributes and URIs; keep them plain.
SAFE_PATH = re.compile(r"^[A-Za-z0-9._\-/]+$")
FIXED_TIME = (2026, 1, 1, 0, 0, 0)  # reproducible zip timestamps

CERT_CONFIG = """\
[ req ]
distinguished_name = req_distinguished_name
x509_extensions = v3_ca
[ req_distinguished_name ]
[ v3_ca ]
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always,issuer
basicConstraints = CA:true
"""


def fail(message):
    sys.exit("build.py: " + message)


def openssl(*args, data=None):
    try:
        result = subprocess.run(["openssl", *args], input=data, capture_output=True, check=False)
    except FileNotFoundError:
        fail("the `openssl` command wasn't found.")
    if result.returncode != 0:
        fail("openssl %s failed:\n%s" % (args[0], result.stderr.decode(errors="replace")))
    return result.stdout


def read_version():
    manifest = (SRC / "CSXS" / "manifest.xml").read_text(encoding="utf-8")
    match = re.search(r'ExtensionBundleVersion="([^"]+)"', manifest)
    if not match:
        fail("ExtensionBundleVersion not found in CSXS/manifest.xml")
    return match.group(1)


def collect_files():
    files = []
    for path in sorted(SRC.rglob("*")):
        rel = path.relative_to(SRC).as_posix()
        if path.name in SKIP_NAMES or rel.startswith("META-INF/") or rel == "mimetype" or "__MACOSX" in rel:
            continue
        if path.is_symlink():
            fail("symlinks aren't allowed in the extension: " + rel)
        if path.is_dir():
            continue
        if not SAFE_PATH.match(rel):
            fail("use only letters, digits, '.', '_', '-' in file names: " + rel)
        files.append((rel, path.read_bytes()))
    if not any(rel == "CSXS/manifest.xml" for rel, _ in files):
        fail("extension/CSXS/manifest.xml is missing")
    return files


def ensure_certificate(key_path, cert_path):
    if key_path.exists() and cert_path.exists():
        return
    SIGNING.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as cfg:
        cfg.write(CERT_CONFIG)
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "9125",
            "-subj", "/O=Braised Animation/CN=Braised Animation",
            "-config", cfg.name, "-extensions", "v3_ca",
            "-keyout", str(key_path), "-out", str(cert_path))
    Path(cfg.name).unlink()
    print("Created a self-signed certificate in " + str(SIGNING))


def b64(data):
    return base64.b64encode(data).decode("ascii")


def manifest_xml(files, canonical=False):
    """The <Manifest> element. With canonical=True, exactly the bytes
    Canonical XML 1.0 produces for it inside the signature (the inherited
    default namespace is written on the element)."""
    start = '<Manifest xmlns="%s" Id="PackageContents">' % DSIG_NS if canonical else '<Manifest Id="PackageContents">'
    refs = "".join(
        '<Reference URI="%s"><DigestMethod Algorithm="%s"></DigestMethod><DigestValue>%s</DigestValue></Reference>\n'
        % (rel, SHA256, b64(hashlib.sha256(data).digest()))
        for rel, data in files
    )
    return start + "\n" + refs + "</Manifest>"


def signed_info_xml(manifest_digest, canonical=False):
    start = '<SignedInfo xmlns="%s">' % DSIG_NS if canonical else "<SignedInfo>"
    return (
        start + "\n"
        '<CanonicalizationMethod Algorithm="%s"></CanonicalizationMethod>\n'
        '<SignatureMethod Algorithm="%s"></SignatureMethod>\n'
        '<Reference URI="#PackageContents">\n'
        "<Transforms>\n"
        '<Transform Algorithm="%s"></Transform>\n'
        "</Transforms>\n"
        '<DigestMethod Algorithm="%s"></DigestMethod>\n'
        "<DigestValue>%s</DigestValue>\n"
        "</Reference>\n"
        "</SignedInfo>" % (C14N, RSA_SHA1, C14N, SHA256, manifest_digest)
    )


def signatures_xml(files, key_path, cert_path):
    manifest_digest = b64(hashlib.sha256(manifest_xml(files, canonical=True).encode("utf-8")).digest())
    signed_info_c14n = signed_info_xml(manifest_digest, canonical=True).encode("utf-8")

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(signed_info_c14n)
    signature = openssl("dgst", "-sha1", "-sign", str(key_path), tmp.name)
    Path(tmp.name).unlink()

    cert_der = openssl("x509", "-in", str(cert_path), "-outform", "DER")
    xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
        "<signatures>\n"
        '<Signature xmlns="%s" Id="PackageSignature">\n'
        "%s\n"
        '<SignatureValue Id="PackageSignatureValue">%s</SignatureValue>\n'
        "<KeyInfo>\n"
        "<X509Data>\n"
        "<X509Certificate>%s</X509Certificate>\n"
        "</X509Data>\n"
        "</KeyInfo>\n"
        "<Object>\n"
        "%s\n"
        "</Object>\n"
        "</Signature>\n"
        "</signatures>\n"
    ) % (DSIG_NS, signed_info_xml(manifest_digest), b64(signature), b64(cert_der), manifest_xml(files))
    return xml.encode("utf-8"), signed_info_c14n, signature


def zip_entry(name, is_dir=False):
    info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
    info.create_system = 3  # Unix permissions below
    if is_dir:
        info.external_attr = (0o40755 << 16) | 0x10
        info.compress_type = zipfile.ZIP_STORED
    else:
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
    return info


def write_zxp(out_path, files, signatures):
    written_dirs = set()

    def ensure_dirs(rel):
        parts = rel.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            d = "/".join(parts[:i]) + "/"
            if d not in written_dirs:
                z.writestr(zip_entry(d, is_dir=True), b"")
                written_dirs.add(d)

    with zipfile.ZipFile(out_path, "w") as z:
        mimetype = zip_entry("mimetype")
        mimetype.compress_type = zipfile.ZIP_STORED  # must be first and uncompressed
        z.writestr(mimetype, MIMETYPE)
        for rel, data in files:
            ensure_dirs(rel)
            z.writestr(zip_entry(rel), data)
        ensure_dirs("META-INF/signatures.xml")
        z.writestr(zip_entry("META-INF/signatures.xml"), signatures)


def self_check(out_path, signed_info_c14n, signature, cert_path):
    """Re-read the package: every file must match its manifest digest and the
    signature must verify against the certificate."""
    with zipfile.ZipFile(out_path) as z:
        names = z.namelist()
        if names[0] != "mimetype" or z.getinfo("mimetype").compress_type != zipfile.ZIP_STORED:
            fail("self-check: mimetype must be the first, uncompressed entry")
        sig_xml = z.read("META-INF/signatures.xml").decode("utf-8")
        refs = dict(re.findall(r'<Reference URI="([^"#][^"]*)">.*?<DigestValue>([^<]+)</DigestValue>', sig_xml))
        packaged = [n for n in names if not n.endswith("/") and n not in ("mimetype", "META-INF/signatures.xml")]
        if sorted(refs) != sorted(packaged):
            fail("self-check: manifest doesn't list exactly the packaged files")
        for name in packaged:
            if b64(hashlib.sha256(z.read(name)).digest()) != refs[name]:
                fail("self-check: digest mismatch for " + name)
    pubkey = openssl("x509", "-in", str(cert_path), "-noout", "-pubkey")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "pub.pem").write_bytes(pubkey)
        (tmp / "sig.bin").write_bytes(signature)
        (tmp / "data.bin").write_bytes(signed_info_c14n)
        openssl("dgst", "-sha1", "-verify", str(tmp / "pub.pem"), "-signature", str(tmp / "sig.bin"), str(tmp / "data.bin"))
    return len(packaged)


def main():
    parser = argparse.ArgumentParser(description="Build and sign the Property Linker ZXP.")
    parser.add_argument("--key", type=Path, default=SIGNING / "key.pem", help="PEM private key (default: .signing/key.pem)")
    parser.add_argument("--cert", type=Path, default=SIGNING / "cert.pem", help="PEM certificate (default: .signing/cert.pem)")
    parser.add_argument("--out", type=Path, help="output .zxp path (default: dist/PropertyLinker-<version>.zxp)")
    args = parser.parse_args()

    version = read_version()
    out_path = args.out or DIST / ("PropertyLinker-%s.zxp" % version)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if (args.key == SIGNING / "key.pem") and (args.cert == SIGNING / "cert.pem"):
        ensure_certificate(args.key, args.cert)
    elif not (args.key.exists() and args.cert.exists()):
        fail("--key and --cert must both point to existing PEM files")

    files = collect_files()
    signatures, signed_info_c14n, signature = signatures_xml(files, args.key, args.cert)
    write_zxp(out_path, files, signatures)
    count = self_check(out_path, signed_info_c14n, signature, args.cert)
    print("Built %s (%d files, signed)" % (out_path.relative_to(HERE) if out_path.is_relative_to(HERE) else out_path, count))


if __name__ == "__main__":
    main()
