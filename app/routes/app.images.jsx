// // // download-shopify-images.mjs
// // // Node 18+ recommended (fetch is builtin). If using older Node, install node-fetch and adjust.
// // import fs from 'fs/promises';
// // import path from 'path';
// // import { dirname } from 'path';
// // import { fileURLToPath } from 'url';
// // import { URL } from 'url';

// // const __dirname = dirname(fileURLToPath(import.meta.url));

// // // Required env vars: set SHOP_DOMAIN (e.g. my-shop.myshopify.com), STOREFRONT_ACCESS_TOKEN
// // const SHOP_DOMAIN = '7kjh1v-ra.myshopify.com';
// // const STOREFRONT_ACCESS_TOKEN ='5dbb5859447eb343572de4b3bee51cea';
// // const API_VERSION = '2024-01'; // change if needed
// // const OUTPUT_DIR = path.join(process.cwd(), 'img');
// // const PAGE_SIZE = 50; // can be lowered if you hit rate limits

// // if (!SHOP_DOMAIN || !STOREFRONT_ACCESS_TOKEN) {
// //   console.error('ERROR: Set SHOP_DOMAIN and STOREFRONT_ACCESS_TOKEN environment variables.');
// //   console.error('Example: SHOP_DOMAIN=my-shop.myshopify.com STOREFRONT_ACCESS_TOKEN=xxx node download-shopify-images.mjs');
// //   process.exit(1);
// // }

// // console.log('Starting Shopify image downloader');
// // console.log(`Shop: ${SHOP_DOMAIN} | API version: ${API_VERSION}`);

// // await fs.mkdir(OUTPUT_DIR, { recursive: true });

// // /**
// //  * Helper: sanitize file/dir names
// //  */
// // function sanitizeFileName(name) {
// //   if (!name) return 'unnamed';
// //   return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').slice(0, 120);
// // }

// // /**
// //  * GraphQL helper for Storefront API
// //  */
// // async function storefrontGraphql(query, variables = {}) {
// //   const url = `https://${SHOP_DOMAIN}/api/${API_VERSION}/graphql.json`;
// //   const res = await fetch(url, {
// //     method: 'POST',
// //     headers: {
// //       'Content-Type': 'application/json',
// //       'X-Shopify-Storefront-Access-Token': STOREFRONT_ACCESS_TOKEN,
// //     },
// //     body: JSON.stringify({ query, variables }),
// //   });

// //   if (!res.ok) {
// //     const txt = await res.text().catch(() => '');
// //     throw new Error(`GraphQL HTTP error ${res.status}: ${txt}`);
// //   }

// //   const json = await res.json();
// //   if (json.errors) {
// //     throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
// //   }
// //   return json.data;
// // }

// // /**
// //  * Fetch all collections (paginated)
// //  */
// // async function fetchAllCollections() {
// //   const query = `
// //     query Collections($first: Int!, $after: String) {
// //       collections(first: $first, after: $after) {
// //         edges {
// //           cursor
// //           node {
// //             id
// //             title
// //             handle
// //           }
// //         }
// //         pageInfo {
// //           hasNextPage
// //         }
// //       }
// //     }
// //   `;

// //   const collections = [];
// //   let after = null;

// //   while (true) {
// //     const data = await storefrontGraphql(query, { first: PAGE_SIZE, after });
// //     const edges = data.collections.edges;
// //     for (const edge of edges) {
// //       collections.push(edge.node);
// //     }
// //     if (!data.collections.pageInfo.hasNextPage) break;
// //     after = edges[edges.length - 1].cursor;
// //   }

// //   return collections;
// // }

// // /**
// //  * For a given collection ID, fetch all products (paginated) with variants and images
// //  */
// // async function fetchAllProductsForCollection(collectionId) {
// //   const query = `
// //     query CollectionProducts($collectionId: ID!, $first: Int!, $after: String) {
// //       node(id: $collectionId) {
// //         ... on Collection {
// //           products(first: $first, after: $after) {
// //             edges {
// //               cursor
// //               node {
// //                 id
// //                 title
// //                 handle
// //                 images(first: 50) {
// //                   edges {
// //                     node {
// //                       id
// //                       url
// //                       altText
// //                       width
// //                       height
// //                     }
// //                   }
// //                 }
// //                 variants(first: 250) {
// //                   edges {
// //                     node {
// //                       id
// //                       title
// //                       sku
// //                       image {
// //                         id
// //                         url
// //                         altText
// //                         width
// //                         height
// //                       }
// //                     }
// //                   }
// //                 }
// //               }
// //             }
// //             pageInfo {
// //               hasNextPage
// //             }
// //           }
// //         }
// //       }
// //     }
// //   `;

// //   const products = [];
// //   let after = null;

// //   while (true) {
// //     const data = await storefrontGraphql(query, { collectionId, first: PAGE_SIZE, after });
// //     const node = data.node;
// //     if (!node || !node.products) break; // no products
// //     const edges = node.products.edges;
// //     for (const edge of edges) {
// //       products.push(edge.node);
// //     }
// //     if (!node.products.pageInfo.hasNextPage) break;
// //     after = edges[edges.length - 1].cursor;
// //   }

// //   return products;
// // }

// // /**
// //  * Download an image URL to a Buffer and write to disk
// //  */
// // async function downloadImageToFile(imageUrl, destPath) {
// //   try {
// //     // force best format if possible (Shopify supports ?format=jpg) but we won't overwrite q params
// //     const url = new URL(imageUrl);
// //     // keep existing query params but ensure we have a file extension if none provided
// //     const res = await fetch(url.toString());
// //     if (!res.ok) throw new Error(`HTTP ${res.status}`);
// //     const arrayBuffer = await res.arrayBuffer();
// //     await fs.writeFile(destPath, Buffer.from(arrayBuffer));
// //     return true;
// //   } catch (err) {
// //     console.warn('Failed to download image', imageUrl, err.message);
// //     return false;
// //   }
// // }

// // /**
// //  * Get extension from URL or default to .jpg
// //  */
// // function getExtFromUrl(urlStr) {
// //   try {
// //     const u = new URL(urlStr);
// //     const pathname = u.pathname;
// //     const ext = path.extname(pathname).split('?')[0] || '';
// //     return ext || '.jpg';
// //   } catch {
// //     return '.jpg';
// //   }
// // }

// // /**
// //  * Build file name: productname-sku-WxH.ext
// //  * If sku missing, use 'nosku'. If dimension missing, use 'px'.
// //  */
// // function buildFileName(productName, sku, width, height, ext, variantTitle = '') {
// //   const base = sanitizeFileName(productName || 'product');
// //   const skuPart = sku ? sanitizeFileName(sku) : 'nosku';
// //   const variantPart = variantTitle ? `-${sanitizeFileName(variantTitle)}` : '';
// //   const dimPart = (width && height) ? `${width}x${height}` : 'px';
// //   return `${base}-${skuPart}${variantPart}-${dimPart}${ext}`;
// // }

// // /**
// //  * Main loop
// //  */
// // async function main() {
// //   const collections = await fetchAllCollections();
// //   console.log(`Found ${collections.length} collections.`);

// //   let totalDownloads = 0;
// //   let totalFailed = 0;

// //   for (const coll of collections) {
// //     const cname = coll.title || coll.handle || coll.id;
// //     const collDirName = sanitizeFileName(cname);
// //     const collDir = path.join(OUTPUT_DIR, collDirName);
// //     await fs.mkdir(collDir, { recursive: true });
// //     console.log(`\nProcessing collection "${cname}" -> ${collDir}`);

// //     const products = await fetchAllProductsForCollection(coll.id);
// //     console.log(`  Found ${products.length} products in collection "${cname}"`);

// //     for (const product of products) {
// //       const productName = product.title || product.handle || product.id;
// //       const productImages = (product.images?.edges || []).map(e => e.node);
// //       const variants = (product.variants?.edges || []).map(e => e.node);

// //       if (variants.length > 0) {
// //         // Has variants → use variant images, fallback to product images per variant
// //         for (const variant of variants) {
// //           const sku = variant.sku || null;
// //           const variantTitle = variant.title || '';

// //           if (variant.image) {
// //             const img = variant.image;
// //             const ext = getExtFromUrl(img.url);
// //             const fname = buildFileName(productName, sku, img.width, img.height, ext, variantTitle);
// //             const dest = path.join(collDir, fname);
// //             const ok = await downloadImageToFile(img.url, dest);
// //             ok ? totalDownloads++ : totalFailed++;
// //             await new Promise(r => setTimeout(r, 60));
// //           } else {
// //             for (const img of productImages) {
// //               const ext = getExtFromUrl(img.url);
// //               const fname = buildFileName(productName, sku, img.width, img.height, ext, variantTitle);
// //               const dest = path.join(collDir, fname);
// //               const ok = await downloadImageToFile(img.url, dest);
// //               ok ? totalDownloads++ : totalFailed++;
// //               await new Promise(r => setTimeout(r, 50));
// //             }
// //           }
// //         }
// //       } else {
// //         // No variants → download product images with nosku
// //         if (productImages.length === 0) {
// //           console.log(`    No images for product "${productName}"`);
// //         }
// //         for (const img of productImages) {
// //           const ext = getExtFromUrl(img.url);
// //           const fname = buildFileName(productName, null, img.width, img.height, ext);
// //           const dest = path.join(collDir, fname);
// //           const ok = await downloadImageToFile(img.url, dest);
// //           ok ? totalDownloads++ : totalFailed++;
// //           await new Promise(r => setTimeout(r, 50));
// //         }
// //       }
// //     }
// //   }

// //   console.log('\nDone.');
// //   console.log(`Total downloaded: ${totalDownloads}`);
// //   console.log(`Total failed: ${totalFailed}`);
// // }


// // main().catch(err => {
// //   console.error('Fatal error:', err);
// //   process.exit(1);
// // });

// import { json } from "@remix-run/node";

// /**
//  * @param {import("@remix-run/node").LoaderFunctionArgs} args
//  */
// export async function loader({ params }) {
//   const discountId = params.id;
//   const shopDomain = 'ghost-app-dev.myshopify.com';
//   const adminToken = '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';

// const query = `
// query {
//   discountNode(id: "gid://shopify/DiscountAutomaticNode/1739009196371") {
//     id
//     discount {
//       __typename
//       ... on DiscountAutomaticApp {
//         title
//         startsAt
//         endsAt
//         status
//         combinesWith {
//           orderDiscounts
//           productDiscounts
//           shippingDiscounts
//         }
//       }
//       ... on DiscountAutomaticBasic {
//         title
//         startsAt
//         endsAt
//         status
//         combinesWith {
//           orderDiscounts
//           productDiscounts
//           shippingDiscounts
//         }
//         customerGets {
//           value {
//             __typename
//             ... on DiscountPercentage {
//               percentage
//             }
//             ... on DiscountAmount {
//               amount {
//                 amount
//                 currencyCode
//               }
//             }
//           }
//           items {
//             __typename
//             ... on DiscountProducts {
//               products(first: 10) {
//                 edges {
//                   node {
//                     id
//                     title
//                   }
//                 }
//               }
//             }
//             ... on DiscountCollections {
//               collections(first: 10) {
//                 edges {
//                   node {
//                     id
//                     title
//                   }
//                 }
//               }
//             }
//             ... on DiscountAll {
//               all
//             }
//           }
//         }
//       }
//       ... on DiscountAutomaticBxgy {
//         title
//         startsAt
//         endsAt
//         status
//         combinesWith {
//           orderDiscounts
//           productDiscounts
//           shippingDiscounts
//         }
//         customerBuys {
//           items {
//             __typename
//             ... on DiscountProducts {
//               products(first: 10) {
//                 edges {
//                   node {
//                     id
//                     title
//                   }
//                 }
//               }
//             }
//             ... on DiscountCollections {
//               collections(first: 10) {
//                 edges {
//                   node {
//                     id
//                     title
//                   }
//                 }
//               }
//             }
//             ... on DiscountAll {
//               all
//             }
//           }
//           quantity {
//             quantity
//           }
//         }
//         customerGets {
//           items {
//             __typename
//             ... on DiscountProducts {
//               products(first: 10) {
//                 edges {
//                   node {
//                     id
//                     title
//                   }
//                 }
//               }
//             }
//             ... on DiscountCollections {
//               collections(first: 10) {
//                 edges {
//                   node {
//                     id
//                     title
//                   }
//                 }
//               }
//             }
//             ... on DiscountAll {
//               all
//             }
//           }
//           value {
//             __typename
//             ... on DiscountPercentage {
//               percentage
//             }
//             ... on DiscountAmount {
//               amount {
//                 amount
//                 currencyCode
//               }
//             }
//           }
//           quantity {
//             quantity
//           }
//         }
//       }
//       ... on DiscountPercentage {
//         percentage
//       }
//       ... on DiscountAmount {
//         amount {
//           amount
//           currencyCode
//         }
//       }
//     }
//   }
// }
// `;



//   try {
//     const response = await fetch(`https://${shopDomain}/admin/api/2025-10/graphql.json`, {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'X-Shopify-Access-Token': adminToken,
//       },
//       body: JSON.stringify({ query, variables: { discountId } }),
//     });

//     if (!response.ok) {
//       throw new Error(`Shopify API responded with status: ${response.status}`);
//     }

//     const data = await response.json();

//     if (data.errors) {
//       return json({ error: data.errors[0].message }, { status: 400 });
//     }

//     return json(data);
//   } catch (error) {
//     console.error('Discount fetch error:', error);
//     return json({ error: 'Failed to fetch discount details' }, { status: 500 });
//   }
// }
