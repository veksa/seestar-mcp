/**
 * The telescope's own file store.
 *
 * A Seestar keeps what it captures in `MyWorks`, one folder per target, and serves it over plain
 * HTTP. `get_albums` lists it — but only as paths relative to a parent folder, so the absolute URL
 * has to be assembled. `get_last_image` is the one call that returns a complete URL, which makes it
 * the reliable way to learn the telescope's own address: it is not necessarily the machine running
 * seestar_alp.
 */

export interface AlbumFile {
	name: string;
	/** Path of the thumbnail, relative to the album's parent folder. */
	thumbnailPath: string;
	/** Path of the full-size image, derived from the thumbnail's. */
	imagePath: string;
	/** The Seestar marks sub-frame variants by suffixing the name. */
	isSubframe: boolean;
}

export interface Album {
	name?: string;
	files: AlbumFile[];
}

export interface AlbumListing {
	/** Usually "MyWorks". */
	parentPath: string;
	albums: Album[];
}

/** Turn the firmware's reply into something with names and paths in it. */
export function parseAlbums(raw: unknown): AlbumListing {
	const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const parentPath = typeof record.path === "string" ? record.path : "MyWorks";
	const list = Array.isArray(record.list) ? (record.list as unknown[]) : [];

	return {
		parentPath,
		albums: list.map((entry) => {
			const album = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
			const files = Array.isArray(album.files) ? (album.files as unknown[]) : [];

			return {
				...(typeof album.name === "string" ? { name: album.name } : {}),
				files: files.flatMap((fileEntry) => {
					const file = (fileEntry && typeof fileEntry === "object" ? fileEntry : {}) as Record<
						string,
						unknown
					>;
					const name = typeof file.name === "string" ? file.name : undefined;
					const thumbnailPath = typeof file.thn === "string" ? file.thn : undefined;
					if (!name || !thumbnailPath) return [];

					return [
						{
							name,
							thumbnailPath,
							imagePath: fullSizePath(thumbnailPath),
							isSubframe: name.endsWith("-sub"),
						},
					];
				}),
			};
		}),
	};
}

/** `M31/Light_M31_thn.jpg` -> `M31/Light_M31.jpg`, the way the driver does it. */
export function fullSizePath(thumbnailPath: string): string {
	const [stem] = thumbnailPath.split("_thn.jpg");
	return stem === thumbnailPath ? thumbnailPath : `${stem}.jpg`;
}

/** Join the telescope's address, the parent folder and a relative path into one URL. */
export function fileUrl(baseUrl: string, parentPath: string, relativePath: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	const parent = parentPath.replace(/^\/+|\/+$/g, "");
	const path = relativePath.replace(/^\/+/, "");
	const segments = [parent, path].filter((part) => part !== "").join("/");
	return `${base}/${segments}`;
}

/**
 * The telescope's own origin, taken from a complete URL the driver produced.
 *
 * Falls back to the given address — the machine running seestar_alp — which is right whenever the
 * driver and the telescope are on the same host, and wrong in a way the caller can see.
 */
export function imageOrigin(lastImageUrl: string | undefined, fallbackHost: string): string {
	if (lastImageUrl) {
		try {
			return new URL(lastImageUrl).origin;
		} catch {
			// Not a URL after all; fall through.
		}
	}
	return `http://${fallbackHost}`;
}
