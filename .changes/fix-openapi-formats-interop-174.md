### Fixed

- OpenAPI contract tests now invoke the callable `ajv-formats` default import directly instead of
  depending on its current CommonJS build also attaching a redundant nested `.default` property.
