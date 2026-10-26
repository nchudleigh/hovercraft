-include .env
export

.PHONY: package clean promo release version

package: clean
	mkdir -p dist && zip -r dist/hovercraft.zip manifest.json card.js card.css bridge.js popup.html popup.js icons/*.png LICENSE

promo:
	python3 scripts/promo.py $(AUDIO)

# make version V=2.2.0
version:
	@test -n "$(V)" || (echo "usage: make version V=x.y.z" && exit 1)
	python3 -c "import json,re; p='manifest.json'; s=open(p).read(); open(p,'w').write(re.sub(r'\"version\": \"[^\"]+\"', '\"version\": \"$(V)\"', s, count=1))"

# make release V=2.2.0
release: version package
	scripts/release.sh

clean:
	rm -rf dist
