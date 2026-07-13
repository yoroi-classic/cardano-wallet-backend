### Fixed

- A token whose CIP-25 mint metadata is keyed by the raw hex asset name, but which declares no
  `version`, now resolves its name and image instead of coming back as `source: "none"`. CIP-25
  says an undeclared version means version 1, which keys the map by the asset name as UTF-8
  text, but minters key by hex anyway: 21 assets sampled on preprod do exactly this, and their
  names are 32-byte hashes that are not valid UTF-8, so no text key could ever have matched.
  Those tokens had no registry entry and no CIP-68 datum either, so they rendered with no name
  and no image at all. The spec-implied key is still tried first, and only a miss falls through
  to the other form, so an asset can never be handed a sibling's metadata.
