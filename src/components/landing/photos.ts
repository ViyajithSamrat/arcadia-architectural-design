// Openly licensed photographs of the world this service works in. None of them is a
// project of ours. Source records: public/landing/photos/credits.json

export interface Photo {
  src: string;
  width: number;
  height: number;
  alt: string;
  title: string;
  creator: string;
  license: string;
  licenseUrl: string;
  page: string;
}

const dir = "/landing/photos";

export const PHOTOS = {
  keralaHouse: {
    src: `${dir}/kerala-house.jpg`,
    width: 2048,
    height: 1536,
    alt: "A heritage house in Kollengode, Kerala, with tiled roofs, green shutters and coconut palms around a sandy yard.",
    title: "Kerala-style heritage house, Kollengode",
    creator: "Bigul Malayi",
    license: "CC0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    page: "https://wordpress.org/photos/photo/8846a27db9/",
  },
  jogloRoom: {
    src: `${dir}/joglo-room.jpg`,
    width: 1920,
    height: 1440,
    alt: "A wide living room under a timber ceiling held up by four wooden columns.",
    title: "Living Room Interior of Joglo Suyadi",
    creator: "Sam Hidayat",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    page: "https://commons.wikimedia.org/w/index.php?curid=167131436",
  },
  lalbaghTree: {
    src: `${dir}/lalbagh-tree.jpg`,
    width: 1920,
    height: 1236,
    alt: "The huge buttressed roots and grey trunk of an old tree in Lalbagh, Bengaluru.",
    title: "GIANT tree at Lalbagh Garden",
    creator: "Ryan from Toronto, Canada",
    license: "CC BY 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
    page: "https://commons.wikimedia.org/w/index.php?curid=76312533",
  },
  vacantPlot: {
    src: `${dir}/vacant-plot.jpg`,
    width: 1600,
    height: 1200,
    alt: "An empty fenced plot of land with bare trees and houses beyond it.",
    title: "Vacant plot of land",
    creator: "Richard Sutcliffe",
    license: "CC BY-SA 2.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/2.0/",
    page: "https://commons.wikimedia.org/w/index.php?curid=155850242",
  },
  livingRoom: {
    src: `${dir}/living-room.jpg`,
    width: 1920,
    height: 1440,
    alt: "A living room with a red concrete floor, a round dining table and tall windows.",
    title: "Gordon House living room interior",
    creator: "EncMstr",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    page: "https://commons.wikimedia.org/w/index.php?curid=3273063",
  },
  lalbaghGarden: {
    src: `${dir}/lalbagh-garden.jpg`,
    width: 1920,
    height: 1449,
    alt: "The glass house at Lalbagh, Bengaluru, at the end of a path lined with clipped hedges and lawn.",
    title: "Lalbagh Garden Beauty",
    creator: "Augustus Binu / dreamsparrow.net",
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    page: "https://commons.wikimedia.org/w/index.php?curid=26118765",
  },
} satisfies Record<string, Photo>;
