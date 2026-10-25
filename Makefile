.PHONY: package clean

package: clean
	mkdir -p dist && zip -r dist/hovercraft.zip manifest.json card.js card.css icons/*.png LICENSE

clean:
	rm -rf dist
