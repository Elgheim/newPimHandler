/* eslint-disable quote-props */
/* eslint-disable require-jsdoc */
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

import fetch from "node-fetch-commonjs";
import btoa from "btoa";

// // The Firebase Admin SDK to access Firestore.
// // import admin = require("firebase-admin");
// // import initializeApp = require("firebase/app");
// // const getDatabase = require('firebase/firebase')

// // import {getFirestore} from "firebase-admin/firestore";

admin.initializeApp();

const db = admin.firestore();

const wpUrl = "https://wooreact.kinsta.cloud/wp-json";
const wpUrlBase = "https://wooreact.kinsta.cloud";

exports.syncVariantGallery = functions.https.onRequest(
  async (req, res): Promise<any> => {
    const { method } = req;
    // Ignore non-POST requests
    if (method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    //   const { accessToken } = await client.clientCredentials();
    //   const token = accessToken;

    const response = await fetch(
      "https://pimhandler.vercel.app/api/getTokenPim",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const data = (await response.json()) as JSONResponse;

    const token = data?.session?.accessToken;

    const { productArray, imageIds } = await useGetDataFromPim(token);

    await handleImageSync(imageIds, token)
      .then(async () => await handleUpdate(productArray))
      .then(() => console.log("ferdig"))
      .catch((error) => console.error(error));

    //   res.status(200).json({ productArray: productArray, ids: imageIds });
    res.status(200).json("DONE");
    return "done";
  }
);

async function useGetDataFromPim(token: token): Promise<PimResponseData> {
  // Bytte til let for match når match logikk er implementert igjen
  const match = 0;
  let page = 0;
  let last = false;

  const imageIds: ImageIds[] = [];
  const productArray: oneVariant[] = [];

  while (match < 1 && last !== true) {
    const data = await fetch(
      `https://amundsensports-feed.isysnet.no/export/export?includeLastModifiedTimestamp=true&page=${page}&&excludeData=PRODUCT_HEAD&&excludeData=ATTRIBUTE&&excludeData=TEXT&&excludeData=RELATION&&excludeData=VARIANT&&excludeData=LINKED_TO&&excludeData=PACKAGING&&excludeData=STRUCTURE`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const variantsFromPim = (await data.json()) as pimProductResponse;

    if (variantsFromPim.last !== undefined) {
      last = variantsFromPim.last;
    }

    await Promise.all(
      variantsFromPim?.content.map(async (variant: pimProduct) => {
        // Pim data
        const sku = variant.identifier?.productNo;
        // const updateTime = variant.productHead?.modifiedTime;

        const oneVariantMediaArray: oneVariantMediaArray[] = [];
        const imageIdArray: ImageIds[] = [];

        // Loop media/images
        variant.media.map(async (mediaItem: pimMedia) => {
          let sourceUrl = "";
          let imageName = "";

          if (mediaItem?.sourceId !== null) {
            const splitSourceId = mediaItem.sourceId.split("/wp-content/");
            sourceUrl = `${wpUrlBase}/wp-content/${
              splitSourceId[1] !== undefined
                ? splitSourceId[1]
                : "SuperDuperFeil"
            }`;

            const url = mediaItem.sourceId.split("/");

            imageName = url[url.length - 1];
            imageName.replace(".jpg", "").replace(".png", "");
          }

          // Format data
          oneVariantMediaArray.push({
            mediaCode: mediaItem.mediaCode,
            sortNo: mediaItem.sortNo,
          });
          imageIdArray.push({
            mediaCode: mediaItem.mediaCode,
            sourceId: sourceUrl,
            fileName: imageName,
          });
        });

        const oneVariant = {
          sku: sku,
          media: oneVariantMediaArray,
        };
        imageIds.push(...imageIdArray);
        productArray.push(oneVariant);

        if (variantsFromPim?.last === true) {
          last = true;
        }
      })
    );
    page++;
  }

  return { productArray: productArray, imageIds: imageIds };
}

async function handleImageSync(
  imageIds: ImageIds[],
  token: token
): Promise<imageResponse> {
  const removeDuplicates = new Set(imageIds);
  //   ! Reduserer arrayet så det ikke bruker opp firebase
  //   const formattedIds = [...removeDuplicates];

  const slicedArray = [...removeDuplicates].slice(0, 10);
  const formattedIds = slicedArray;
  // End

  for (let i = 0; i < formattedIds.length; i += 5) {
    await Promise.all([
      ...formattedIds.slice(i, i + 5).map(async (id) => {
        const firebaseInstance = await getItemFromDBbyId(id.mediaCode);

        // Exclude if we have WPid
        if (
          firebaseInstance !== null &&
          firebaseInstance?.wpId !== "undefined" &&
          firebaseInstance?.wpId !== "false"
        ) {
          return;
        }

        // Check if image excist in WP
        const checkIfExsist = await fetch(
          `${wpUrl}/codehouse/v1/fetchmediaidbyurl`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ url: id.fileName }),
          }
        )
          .then(
            async (data) => (await data.json()) as fetchmediaidbyurlResponse
          )
          .catch((error: unknown) =>
            console.error("error from fetchmediaidbyurl", error)
          );

        // If image is in WP, update db
        if (
          checkIfExsist !== "false" &&
          checkIfExsist !== undefined &&
          !Array.isArray(checkIfExsist)
        ) {
          const wpid: string = checkIfExsist ? checkIfExsist : "";
          await setToDB(id.mediaCode, wpid);

          return;
        }

        if (checkIfExsist === "false") {
          const base64Link = await fetchPimMedia(id.mediaCode, token);

          await uploadImage(base64Link, id.fileName, id.mediaCode)
            .then(async (response) => {
              const wpid: string = checkIfExsist ? checkIfExsist : "";

              await setToDB(id.mediaCode, wpid);

              return response;
            })
            .catch((error) => console.error(error));
          return;
        }
      }),
      new Promise((resolve) => {
        setTimeout(resolve, 50);
      }),
    ]);
  }
  return "donw";
}

// Get line by ID
async function getItemFromDBbyId(id: string) {
  try {
    const idRef = db.collection("imageIdsDictionary").doc(id);
    const docSnap = await idRef.get();

    if (docSnap.exists) {
      return docSnap.data();
    } else {
      return null;
    }
  } catch (error: unknown) {
    console.error(error);
    return null;
  }
}

// Write to database
async function setToDB(mediaCode: string, wpId: string) {
  try {
    // Defines where to send and which position
    const idRef = db.collection("imageIdsDictionary");

    // Sends the new entry
    await idRef.doc(mediaCode).set({ wpId: wpId });
  } catch (err: unknown) {
    console.log("Error while setting db: ", err);
  }
}

// fetch base_64
async function fetchPimMedia(mediaCode: string, token: token) {
  const pimMedia = await fetch(
    `https://amundsensports-feed.isysnet.no/media/export/base64/mediaCode/withMetaData?mediaCode=${mediaCode}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  ).then(async (response) => {
    return (await response.json()) as pimMediaExport;
  });

  const base64Link = pimMedia?.base64String;

  return base64Link;
}

// upload image to WP
async function uploadImage(base64Link: string, title: string, mediaId: string) {
  const imageId = await fetch(`${wpUrl}/skai/v1/uploadImageV2`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      base64_img: base64Link,
      title: title,
      mediaId: mediaId,
    }),
  })
    .then(async (response) => (await response.json()) as string)
    .catch((error: unknown) => console.error(error));
  return imageId;
}

// async function updateWpImageMeta(wpId: string, mediaId: string) {
//   const imageId = await fetch(`${wpUrl}/skai/v1/update_meta/${wpId}`, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify({
//       id: wpId,
//       mediaCode: `${mediaId}`,
//     }),
//   }).then( async (response) => await response.json())
//       .catch((error) => console.error(error));
//   return imageId;
// }

// !Byttet productArray med slicedArray
async function handleUpdate(productArray: oneVariant[]) {
  const slicedArray = productArray.slice(0, 20);

  for (let i = 0; i < slicedArray.length; i += 5) {
    await Promise.all([
      ...slicedArray.slice(i, i + 5).map(async (variant) => {
        try {
          const { sku, media } = variant;

          // String version of output image array, in order
          let wpVariantArray = "";

          const variantWp = await handleFetchVariantBySku(sku);

          const sortedArray = media?.sort((a, b) => a.sortNo - b.sortNo);

          // Loop through all images
          await Promise.all(
            sortedArray.map(async (item) => {
              // ! Ingen validering da data skal ligge i firebase
              const wordpressId = await getItemFromDBbyId(item.mediaCode);
              wpVariantArray += `${String(wordpressId?.wpId)}, `;
              // wpVariantArray += `${String(item.mediaCode)}, `;
              return;
            })
          ).then(async () => {
            // Clean up formatting
            wpVariantArray = wpVariantArray.slice(0, -2);

            // Find exsisting variation gallery
            const exsistingArray = variantWp?.meta_data.filter(
              (item: wooMeta) => item?.key === "_wc_additional_variation_images"
            );

            // Update variant if not the same as exsistingArray
            if (exsistingArray[0]?.value !== wpVariantArray) {
              await updateWCVariantImage(
                String(variantWp.parent_id),
                String(variantWp.id),
                wpVariantArray
              );
            }
          });
          return;
        } catch (error) {
          console.error(error);
        }
      }),
    ]);
  }
}

async function handleFetchVariantBySku(sku: string) {
  const products = await fetch(`${wpUrl}/wc/v3/products?sku=${sku}`, {
    method: "GET",
    headers: {
      Authorization:
        "Basic " +
        btoa(
          // eslint-disable-next-line max-len
          `${process.env.NEXT_PUBLIC_WP_API_KEY_LIVE}:${process.env.NEXT_PUBLIC_WP_API_SECRET_LIVE}`
        ),
      "Content-Type": "application/json",
    },
  })
    .then(async (response) => (await response.json()) as WooProduct[])
    .catch((error) => {
      console.log(error);
      return [];
    });

  return products[0];
}

async function updateWCVariantImage(
  parentId: string,
  variantId: string,
  wpVariantArray: string
) {
  const data = {
    meta_data: [
      {
        key: "_wc_additional_variation_images",
        value: wpVariantArray,
      },
    ],
  };

  const response = await fetch(
    `${wpUrl}/wc/v3/products/${parentId}/variations/${variantId}`,
    {
      method: "PUT",
      headers: {
        Authorization:
          "Basic " +
          btoa(
            // eslint-disable-next-line max-len
            `${process.env.NEXT_PUBLIC_WP_API_KEY_LIVE}:${process.env.NEXT_PUBLIC_WP_API_SECRET_LIVE}`
          ),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    }
  )
    .then(async (response) => {
      const product = (await response.json()) as WooProduct;
      return product;
    })
    .catch((error: unknown) => {
      console.log("Error: ", error);
    });

  return response;
}

type pimProduct = {
  identifier: {
    importCode: string;
    productNo: string;
  };
  productHead: {
    name: {
      en: string;
    };
    alternativeName: object;
    productNo: string;
    altProductNo?: null | string;
    status: object;
    type: object;
    owner: null;
    group: null;
    supplier: null;
    base: boolean;
    baseProduct?: object;
    productType: string;
    deleted: boolean;
    modifiedTime: string;
  };
  media: pimMedia[];
};

type pimMedia = {
  action: string;
  mediaCode: string;
  mediaRoleCodes: string[];
  url: string;
  mediaURL: string;
  metaDataURL: string;
  description: null;
  sortNo: number;
  mediaType: string;
  fileName: string;
  sourceId: string;
  modifiedTime: string;
};

type JSONResponse = {
  session?: {
    accessToken?: string;
    expiresAt?: number;
    refreshToken?: null;
  };
  errors?: Array<{ message: string }>;
};
type PimResponseData = {
  productArray: oneVariant[];
  imageIds: ImageIds[];
};

type ImageIds = {
  mediaCode: string;
  sourceId: string;
  fileName: string;
};

type token = string | undefined;

type pimProductResponse = {
  content: pimProduct[];
  pageable?: object;
  totalPages?: number;
  totalElements?: number;
  last?: boolean;
  size?: number;
  number?: number;
  sort?: object;
  numberOfElements?: number;
  first?: boolean;
  empty?: boolean;
};

type oneVariant = {
  sku: string;
  media: oneVariantMediaArray[];
};

type oneVariantMediaArray = {
  mediaCode: string;
  sortNo: number;
};

type fetchmediaidbyurlResponse = string | undefined | null;

type WooProduct = {
  id: number;
  name?: string;
  slug?: string;
  permalink?: string;
  date_created?: string;
  date_created_gmt?: string;
  date_modified?: string;
  date_modified_gmt?: string;
  type?: string;
  status?: string;
  featured?: boolean;
  catalog_visibility?: string;
  description?: string;
  short_description?: string;
  sku?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  date_on_sale_from?: string | null;
  date_on_sale_from_gmt?: string | null;
  date_on_sale_to?: string | null;
  date_on_sale_to_gmt?: string | null;
  on_sale?: boolean;
  purchasable?: true;
  total_sales?: string;
  virtual?: boolean;
  downloadable?: boolean;
  downloads?: [];
  download_limit?: number;
  download_expiry?: number;
  external_url?: string;
  button_text?: string;
  tax_status?: string;
  tax_class?: string;
  manage_stock?: true;
  stock_quantity?: number;
  backorders?: string;
  backorders_allowed?: boolean;
  backordered?: boolean;
  low_stock_amount?: boolean | null;
  sold_individually?: boolean;
  weight?: string;
  dimensions?: object;
  shipping_required?: boolean;
  shipping_taxabl?: boolean;
  shipping_class?: string;
  shipping_class_id?: number;
  reviews_allowed?: boolean;
  average_rating?: string;
  rating_count?: number;
  upsell_ids?: [];
  cross_sell_ids?: [];
  parent_id: number;
  purchase_note?: string;
  categories?: [];
  tags?: [];
  images?: [];
  attributes?: [];
  default_attributes?: [];
  variations?: [];
  grouped_products?: [];
  menu_order?: number;
  price_html?: string;
  related_ids?: [];
  meta_data: wooMeta[];
  stock_status?: string;
  has_options?: boolean;
  _links?: object;
};

type wooMeta = {
  id: number;
  key: string;
  value: string;
};

type pimMediaExport = {
  mediaId?: number;
  mediaType?: string;
  fileName?: string;
  source?: string;
  name?: string;
  categoryImportCode?: string | null;
  qrCode?: string | null;
  description?: string | null;
  products?: [];
  base64String: string;
  imageSide?: string | null;
  imageAngle?: string | null;
};

type imageResponse = string;
