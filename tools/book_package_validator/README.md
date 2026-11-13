# Book package validator

A standalone validator for the read-book-package 1.0.0 directory and ZIP formats.

## Run

```bash
python -m pip install -r tools/book_package_validator/requirements.txt
python tools/book_package_validator/book_package_validator.py validate /path/to/package-directory
python tools/book_package_validator/book_package_validator.py validate /path/to/package.zip --report validation-result.json
```

The validator does not extract ZIP archives. It inspects archive paths and metadata first, then reads only validated package entries. It rejects path traversal, symlink entries, duplicate normalized names, encrypted entries, executable/script file types, oversized entries, excessive total uncompressed size, and suspicious compression ratios.

Resource limits are configurable through CLI options. Defaults are operational safeguards, not frozen product limits. A failed validation exits with code 1; invalid CLI usage or an internal failure exits with code 2.

The package's local report is advisory only. Passing this validator does not mean cloud-side processing, retrieval quality, copyright review, or publication has passed.
