   /**
    * OpenClaw Documentation Crawler
    * Extracts all documentation from https://docs.openclaw.ai/zh-CN and converts to Markdown
    */

   const axios = require('axios');
   const cheerio = require('cheerio');
   const fs = require('fs');
   const path = require('path');

   // Configuration
   const BASE_URL = 'https://docs.openclaw.ai/zh-CN';
   const OUTPUT_DIR = '/home/yxs/.openclaw/workspace/docs-openclaw';
   const RATE_LIMIT_DELAY = 1000; // 1 second between requests
   const MAX_DEPTH = 10; // Maximum recursion depth

   // State
   const visitedUrls = new Set();
   const urlQueue = [];
   const crawledPages = [];
   let errorCount = 0;

   // File system setup
   if (!fs.existsSync(OUTPUT_DIR)) {
     fs.mkdirSync(OUTPUT_DIR, { recursive: true });
   }

   // Initialize queue with base URL
   urlQueue.push({ url: BASE_URL, depth: 0 });

   /**
    * Check if URL is an internal documentation link
    */
   function isInternalUrl(url) {
     try {
       const parsedUrl = new URL(url);
       return parsedUrl.hostname === new URL(BASE_URL).hostname &&
              parsedUrl.pathname.startsWith('/zh-CN');
     } catch (e) {
       return false;
     }
   }

   /**
    * Extract text content from HTML and convert to Markdown
    */
   function convertToMarkdown(html, title = 'Untitled') {
     const $ = cheerio.load(html);

     // Remove navigation, sidebars, footers, and unnecessary elements
     $('nav, .sidebar, .footer, .header, .nav-links, .breadcrumb, .table-of-contents, .comments, .footer-nav, .prev-next').remove();
     $('script, style, link[rel="stylesheet"]').remove( );

     // Get title from h1
     const h1 = $('h1').first().text().trim() || title;

     let markdown = `# ${h1}\n\n`;

     // Convert headings
     $('h1, h2, h3, h4, h5, h6').each((_, el) => {
       const level = el.tagName.toLowerCase();
       const text = $(el).text().trim();
       markdown += `${'#'.repeat(parseInt(level[1]))} ${text}\n\n`;
     });

     // Convert paragraphs
     $('p').each((_, el) => {
       const text = $(el).text().trim();
       if (text) {
         markdown += `${text}\n\n`;
       }
     });

     // Convert links
     $('a').each((_, el) => {
       const text = $(el).text().trim();
       const href = $(el).attr('href');
       if (text && href) {
         markdown += `[${text}](${href})\n\n`;
       }
     });

     // Convert lists
     $('ul, ol').each((_, el) => {
       const $list = $(el);
       const isOrdered = $list.prop('tagName') === 'OL';
       let markdownList = '';

       $list.find('li').each((_, li) => {
         markdownList += `${isOrdered ? '1.' : '-'} ${$(li).text().trim()}\n`;
       });

       markdown += markdownList + '\n';
     });

     // Convert code blocks
     $('pre').each((_, el) => {
       const code = $(el).find('code').first().text( ).trim();
       markdown += `\`\`\`\n${code}\n\`\`\`\n\n`;
     });

     // Convert tables
     $('table').each((_, el) => {
       let markdownTable = '|';
       const $table = $(el);

       // Header
       $table.find('thead th').each((_, th) => {
         markdownTable += ` ${$(th).text().trim()} |`;
       });

       markdownTable += '\n';
       markdownTable += '|-' + Array($table.find('thead th').length).fill('-').join('-') + '|';
       markdownTable += '\n';

       // Body
       $table.find('tbody tr').each((_, tr) => {
         markdownTable += '|';
         $(tr).find('td').each((_, td) => {
           markdownTable += ` ${$(td).text().trim()} |`;
         });
         markdownTable += '\n';
       });

       markdownTable += '\n';
       markdown += markdownTable;
     });

     return markdown.trim();
   }

   /**
    * Extract filename from URL
    */
   function getFilenameFromUrl(url) {
     try {
       const parsedUrl = new URL(url);
       let pathPart = parsedUrl.pathname;

       // Remove trailing slash
       if (pathPart.endsWith('/')) {
         pathPart = pathPart.slice(0, -1);
       }

       // Get the last part of the path
       const parts = pathPart.split('/').filter(Boolean);
       let filename = parts.pop() || 'index';

       // Replace special characters
       filename = filename.replace(/[^a-zA-Z0-9\u4e00-\u9fa5\-_]/g, '_');

       return `${filename}.md`;
     } catch (e) {
       return 'unknown.md';
     }
   }

   /**
    * Save content to Markdown file
    */
   function saveToMarkdown(url, html, content) {
     const filename = getFilenameFromUrl(url);
     const fullFilePath = path.join(OUTPUT_DIR, filename);

     // Create directory structure
     const dir = path.dirname(fullFilePath);
     if (!fs.existsSync(dir)) {
       fs.mkdirSync(dir, { recursive: true });
     }

     fs.writeFileSync(fullFilePath, content, 'utf8');
     console.log(`✓ Saved: ${filename}`);

     crawledPages.push({
       url,
       filename,
       date: new Date().toISOString()
     });
   }

   /**
    * Fetch and process a single URL
    */
   async function crawlUrl(url, depth) {
     if (depth > MAX_DEPTH) {
       console.log(`⚠ Max depth reached: ${url}`);
       return;
     }

     if (visitedUrls.has(url)) {
       return;
     }

     visitedUrls.add(url);

     try {
       console.log(`🔍 Crawling: ${url} (depth: ${depth})`);

       const response = await axios.get(url, {
         headers: {
           'User-Agent': 'Mozilla/5.0 (compatible; OpenClawCrawler/1.0)',
           'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
           'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
         },
         timeout: 30000,
         maxRedirects: 5,
         validateStatus: (status) => status < 500,
       });

       if (!response.headers['content-type']?.includes('text/html')) {
         console.log(`  ⚠ Not HTML: ${url}`);
         return;
       }

       const html = response.data;
       const markdown = convertToMarkdown(html, new URL(url).pathname);
       saveToMarkdown(url, html, markdown);

       const $ = cheerio.load(html);
       const baseUrl = new URL(BASE_URL);

       $('a[href]').each((_, el) => {
         let href = $(el).attr('href');

         if (href.startsWith('/')) {
           href = `${baseUrl.origin}${href}`;
         } else if (!href.startsWith('http')) {
           href = `${baseUrl.origin}${baseUrl.pathname}${href}`;
         }

         if (isInternalUrl(href) && !visitedUrls.has(href) && !urlQueue.find(item => item.url === href)) {
           urlQueue.push({ url: href, depth: depth + 1 });
         }
       });

     } catch (error) {
       errorCount++;
       if (error.response) {
         console.log(`  ✗ Failed with status ${error.response.status}: ${url}`);
       } else if (error.code) {
         console.log(`  ✗ Failed (${error.code}): ${url}`);
       } else {
         console.log(`  ✗ Failed: ${error.message}`);
       }
     }

     await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
   }

   async function startCrawl() {
     console.log('🚀 Starting OpenClaw Documentation Crawler\n');
     console.log(`📁 Output directory: ${OUTPUT_DIR}`);
     console.log(`🎯 Target: ${BASE_URL}`);
     console.log(`⏱️  Rate limit: ${RATE_LIMIT_DELAY}ms between requests`);
     console.log(`🔗 Max depth: ${MAX_DEPTH}\n`);

     const startTime = Date.now();

     while (urlQueue.length > 0) {
       const { url, depth } = urlQueue.shift();
       await crawlUrl(url, depth);
     }

     const duration = ((Date.now() - startTime) / 1000).toFixed(2);
     console.log(`\n✅ Crawling complete!`);
     console.log(`📄 Pages crawled: ${crawledPages.length}`);
     console.log(`❌ Errors: ${errorCount}`);
     console.log(`⏱️  Duration: ${duration}s`);

     const summary = {
       baseUrl: BASE_URL,
       crawledPages,
       errorCount,
       duration,
       createdAt: new Date().toISOString()
     };

     fs.writeFileSync(
       path.join(OUTPUT_DIR, 'CRAWL_SUMMARY.json'),
       JSON.stringify(summary, null, 2),
       'utf8'
     );

     console.log(`📊 Summary saved to: ${path.join(OUTPUT_DIR, 'CRAWL_SUMMARY.json')}`);
   }

   startCrawl().catch(console.error );
