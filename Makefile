.PHONY: package clean promo

package: clean
	mkdir -p dist && zip -r dist/hovercraft.zip manifest.json card.js card.css icons/*.png LICENSE

promo:
	python3 scripts/promo.py $(AUDIO)

clean:
	rm -rf dist
