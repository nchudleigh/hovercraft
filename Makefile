.PHONY: package clean

package:
	mkdir -p dist && zip -r dist/hovercraft.zip manifest.json card.js card.css README.md LICENSE

clean:
	rm -rf dist
