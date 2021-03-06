/* global pref fetchXHR createProgressBar */

browser.runtime.sendMessage({method: "getBatchData", batchId: getBatchId()})
	.then(req =>
		pref.ready()
			.then(domReady)
			.then(() => init(req))
	);
	
function domReady() {
	if (document.readyState !== "loading") {
		return Promise.resolve();
	}
	return new Promise(resolve => {
		document.addEventListener("DOMContentLoaded", resolve, {once: true});
	});
}	

function getBatchId() {
	const id = new URL(location.href).searchParams.get("batchId");
	return +id;
}

function init({tabs: originalTabs, env}) {
	var container = document.querySelector(".main-container"),
		frag = document.createDocumentFragment();
	const tabs = originalTabs.map(tab =>
		({
			tabId: tab.tabId,
			images: [].concat(...tab.frames.map(f => f.images.map(
				({url, noReferrer}) => {
          const check = createImageCheckbox(url, f.frameId, tab.tabId, noReferrer);
          if (!pref.get("selectByDefault")) {
            check.toggleCheck();
          }
          return check;
        }
			))),
			env: tab.env
		})
	);
  const progress = createProgressBar();
		
	if (!pref.get("isolateTabs") || tabs.length === 1) {
		const container = document.createElement("div");
		container.className = "image-container";
		const appended = new Set;
		for (const tab of tabs) {
			for (const image of tab.images) {
				if (appended.has(image.url)) {
					continue;
				}
				appended.add(image.url);
				container.append(image.el);
				progress.add(image.load());
			}
		}
		frag.appendChild(container);
	} else {
		const ul = document.createElement("ul");
		ul.className = "tab-container";
		for (const tab of tabs) {
			if (!tab.images.length) {
				continue;
			}
			const li = document.createElement("li");
			li.className = "image-container";
			for (const image of tab.images) {
				li.appendChild(image.el);
				progress.add(image.load());
			}
			const counter = document.createElement("div");
			counter.className = "tab-image-counter";
			li.appendChild(counter);
			ul.appendChild(li);
		}
		frag.appendChild(ul);
	}
	
	container.appendChild(frag);
	
	var form = document.forms[0],
		inputs = form.querySelectorAll(".toolbar input, .toolbar select");
	pref.bindElement(form, inputs, true);
	
	initFilter(container, getImages());
	initUI();
	
	var handler = {
		invert() {
			getImages().forEach(i => i.toggleCheck());
		},
		save() {
			browser.runtime.sendMessage({
				method: "batchDownload",
				tabs: tabs.map(t =>
					Object.assign({}, t, {
						images: t.images
							.filter(i => i.selected())
							.map(i => ({
								url: i.url,
								blob: isFirefox() ? i.data.blob : null,
								blobUrl: isFirefox() ? null : i.data.blobUrl,
								filename: i.data.filename
							}))
					})
				),
				env
			})
				.then(() => {
					browser.runtime.sendMessage({method: "closeTab"});
				});
		},
		copyUrl() {
			const input = document.createElement("textarea");
			input.value = getUrls(getImages()).join("\n");
			document.body.appendChild(input);
			input.select();
			document.execCommand("copy");
			input.remove();
			if (!this.originalTextContent) {
				this.originalTextContent = this.textContent;
			}
			this.style.minWidth = this.offsetWidth + "px";
			this.textContent = browser.i18n.getMessage("pickerActionCopyUrlCopied");
			if (this.timer != null) {
				clearTimeout(this.timer);
			}
			this.timer = setTimeout(() => {
				this.textContent = this.originalTextContent;
				this.style.minWidth = "";
				this.timer = null;
			}, 1000);
		},
		cancel() {
			browser.runtime.sendMessage({method: "closeTab"});
		}
	};
	
	var actions = document.querySelector(".actions");
	for (var [cls, cb] of Object.entries(handler)) {
		actions.querySelector(`.${cls}`).onclick = cb;
	}
	
	function getUrls(images) {
		return images.filter(i => i.selected()).map(i => i.url);
	}
	
	function getImages() {
		return [].concat(...tabs.map(t => t.images));
	}
}

function initUI() {
	pref.onChange(changes => {
		if (changes.previewMaxHeightUpperBound != null) {
			update();
		}
	});
	update();
	
	function update() {
		document.querySelector("#previewMaxHeight").max = pref.get("previewMaxHeightUpperBound");
	}
}

function initFilter(container, images) {
	var conf = pref.get(),
		FILTER_OPTIONS = ["minFileSize", "minWidth", "minHeight", "matchUrl", "matchType"];
	if (conf.matchUrl) {
		conf.matchUrl = buildRe(conf.matchUrl);
	}
	
	pref.onChange(changes => {
		if (FILTER_OPTIONS.some(o => changes[o] != null)) {
			Object.assign(conf, changes);
			if (conf.matchUrl && typeof conf.matchUrl == "string") {
				conf.matchUrl = buildRe(conf.matchUrl);
			}
			filterAll();
		}
	});
	
	// some images are still loading
	container.addEventListener("imageLoad", e => {
		var {image} = e.detail;
		filter(image);
	});
	
	// some images are already loaded
	filterAll();
	
	function buildRe(re) {
		try {
			return new RegExp(re, "i");
		} catch (err) {
			console.error(err);
		}
		return null;
	}
	
	function valid(image) {
		const {naturalWidth, naturalHeight, error, fileSize} = image.imgEl;
		const src = image.url;
		return !error &&
			fileSize &&
			// svg has no natural width/height
			(!naturalWidth || naturalWidth >= conf.minWidth) &&
			(!naturalHeight || naturalHeight >= conf.minHeight) && 
			(!conf.matchUrl || 
				(conf.matchUrl.test(src) == (conf.matchType == "include"))) &&
			fileSize >= conf.minFileSize * 1024;
	}
	
	function filter(image) {
		image.toggleEnable(valid(image));
	}

	function filterAll() {
		for (var image of images) {
			filter(image);
		}
	}
}

function createImageCheckbox(url, frameId, tabId, noReferrer) {
	const label = document.createElement("label");
	const input = document.createElement("input");
	let ctrl;
	
	label.className = "image-checkbox checked";
	label.onclick = e => {
		if (e.target == input || input.disabled) {
			return;
		}
		const checked = input.checked;
		setTimeout(() => {
			if (input.checked == checked) {
				ctrl.toggleCheck();
				input.focus();
			}
		});
	};
	
	input.type = "checkbox";
	input.checked = true;
	input.onchange = () => {
		label.classList.toggle("checked", input.checked);
	};
	
	label.title = url;
	
	const imgContainer = document.createElement("div");
	imgContainer.className = "image-checkbox-image-container";
	
	const img = new Image;
	img.className = "image-checkbox-image";
	// don't drag
	if (isChrome()) {
		img.draggable = false;
	} else {
		img.ondragstart = () => false;
	}
	
	const imgCover = new Image;
	imgCover.className = "image-checkbox-cover";
	
	imgContainer.append(img, imgCover);
	
	label.append(input, imgContainer);
	
	return ctrl = {
		url,
		data: null,
		el: label,
		imgEl: img,
		toggleEnable(enable) {
			label.classList.toggle("disabled", !enable);
			input.disabled = !enable;
		},
		toggleCheck() {
			label.classList.toggle("checked");
			input.checked = !input.checked;
		},
		selected() {
			return !input.disabled && input.checked;
		},
		load
	};
	
	function validUrl(url) {
		// make sure the URL is not relative?
		try {
			new URL(url);
			return true;
		} catch (err) {
			return false;
		}
	}
	
	function load() {
		return loadImageData()
			.then(data => {
				ctrl.data = data;
				const {resolve, reject, promise} = deferred();
				img.onload = resolve;
				img.onerror = reject;
				img.src = data.blobUrl || URL.createObjectURL(data.blob);
				img.fileSize = data.size;
				if (!validUrl(url)) {
					throw new Error(`Invalid URL: ${url}`);
				}
				imgCover.src = url;
				return promise;
			})
			.then(() => {
				if (pref.get("displayImageSizeUnderThumbnail")) {
					const info = document.createElement("span");
					info.className = "image-checkbox-info";
					info.textContent = `${img.naturalWidth} x ${img.naturalHeight}`;
					label.append(info);
				} else {
					if (img.naturalWidth) {
						label.title += ` (${img.naturalWidth} x ${img.naturalHeight})`;
					}
				}
				label.title += ` [${formatFileSize(img.fileSize)}]`;
				
				// default width for svg
				if (!img.naturalHeight) {
					img.style.width = "200px";
				}
			})
			.then(() => {
				// https://bugzilla.mozilla.org/show_bug.cgi?id=329509
				img.dispatchEvent(new CustomEvent("imageLoad", {
					bubbles: true,
					detail: {image: ctrl}
				}));
			})
			.catch(err => {
				img.error = true;
        throw err;
			});
	}
	
	function loadImageData() {
		let data;
		return (
      noReferrer && isChrome() ?
        browser.runtime.sendMessage({method: "fetchImage", url})
          .then(data => {
            data.fromBackground = true;
            return data;
          }) :
        browser.tabs.sendMessage(tabId, {method: "fetchImage", url}, {frameId})
    )
			.then(_data => {
				data = _data;
				if (!data.blob) {
					// cache the blob so users can close the tab after that
					return fetchXHR(data.blobUrl, "blob")
						.then(r => {
              if (data.fromBackground) {
                browser.runtime.sendMessage({method: "revokeURL", url: data.blobUrl});
              } else {
                browser.tabs.sendMessage(tabId, {method: "revokeURL", url: data.blobUrl}, {frameId});
              }
              const blob = r.response;
							data.blob = blob;
							data.blobUrl = URL.createObjectURL(blob);
						});
				}
			})
			.then(() => data);
	}
}

function formatFileSize(size) {
	return `${(size / 1024).toFixed(2)} KB`;
}

function isFirefox() {
	return typeof InstallTrigger !== "undefined";
}

function isChrome() {
	return chrome.app;
}

function deferred() {
	const o = {};
	o.promise = new Promise((resolve, reject) => {
		o.resolve = resolve;
		o.reject = reject;
	});
	return o;
}
