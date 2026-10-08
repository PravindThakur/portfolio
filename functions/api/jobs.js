export async function onRequestGet(context) {

    /*
     * =========================================================
     * SETTINGS
     * =========================================================
     */

    // Keep jobs for 30 days
    const ARCHIVE_DAYS = 30;

    // Contact LinkedIn at most once every 15 minutes
    const REFRESH_SECONDS = 15 * 60;

    const now = new Date();

    const cutoff = new Date(
        now.getTime() -
        ARCHIVE_DAYS * 24 * 60 * 60 * 1000
    );


    /*
     * =========================================================
     * CACHE
     *
     * We use Cloudflare Cache as a lightweight rolling archive.
     *
     * No D1 database is required.
     * =========================================================
     */

    const cache = caches.default;

    const origin =
        new URL(context.request.url).origin;


    /*
     * Cache containing our accumulated 30-day job archive.
     */

    const archiveUrl =
        `${origin}/__job_archive_v2`;


    /*
     * Cache used to control how often we contact LinkedIn.
     */

    const refreshUrl =
        `${origin}/__job_refresh_v2`;


    const archiveKey =
        new Request(
            archiveUrl,
            {
                method: "GET"
            }
        );


    const refreshKey =
        new Request(
            refreshUrl,
            {
                method: "GET"
            }
        );


    /*
     * =========================================================
     * 1. READ EXISTING JOB ARCHIVE
     * =========================================================
     */

    let archive = [];


    try {

        const cachedArchive =
            await cache.match(
                archiveKey
            );


        if (cachedArchive) {

            archive =
                await cachedArchive.json();

        }

    } catch (error) {

        console.log(
            "Archive read failed:",
            error.message
        );

        archive = [];

    }


    /*
     * =========================================================
     * 2. REMOVE JOBS OLDER THAN 30 DAYS
     * =========================================================
     */

    archive =
        archive.filter(
            job => {

                const postedAt =
                    new Date(
                        job.postedAt
                    );


                return (
                    !isNaN(
                        postedAt.getTime()
                    ) &&
                    postedAt >= cutoff
                );

            }
        );


    /*
     * =========================================================
     * 3. CHECK LINKEDIN REFRESH STATUS
     * =========================================================
     */

    let shouldRefresh = true;


    try {

        const refreshCache =
            await cache.match(
                refreshKey
            );


        if (refreshCache) {

            shouldRefresh = false;

        }

    } catch (error) {

        console.log(
            "Refresh cache check failed:",
            error.message
        );

    }


    /*
     * =========================================================
     * VARIABLES FOR RESPONSE
     * =========================================================
     */

    let linkedinStatus = 0;

    let linkedinError = null;

    let newlyDiscovered = 0;


    /*
     * =========================================================
     * 4. FETCH LINKEDIN
     * =========================================================
     *
     * Only one LinkedIn request is made during a refresh.
     *
     * This is intentional.
     *
     * Multiple rapid LinkedIn requests previously caused
     * HTTP 429 rate limiting.
     * =========================================================
     */

    if (shouldRefresh) {


        /*
         * -----------------------------------------------------
         * SEARCH TERMS
         * -----------------------------------------------------
         */

        const keywords =
            'Corporate Actions OR ' +
            'Reference Data OR ' +
            'Capital Markets OR ' +
            'Asset Servicing OR ' +
            'Trade Settlement OR ' +
            '"Business Analyst" OR ' +
            '"Business Analysis" OR ' +
            '"Production Support" OR ' +
            '"Application Support" OR ' +
            '"L2 Support" OR ' +
            '"L3 Support" OR ' +
            '"Production Analyst"';


        const location =
            "India";


        /*
         * Search the last 30 days.
         */

        const seconds =
            ARCHIVE_DAYS *
            24 *
            60 *
            60;


        const params =
            new URLSearchParams();


        params.set(
            "keywords",
            keywords
        );


        params.set(
            "location",
            location
        );


        params.set(
            "f_TPR",
            `r${seconds}`
        );


        /*
         * DD = Date Descending
         *
         * LinkedIn should return newest jobs first,
         * but we ALSO sort ourselves later.
         */

        params.set(
            "sortBy",
            "DD"
        );


        params.set(
            "start",
            "0"
        );


        const linkedinUrl =
            "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
            params.toString();


        /*
         * -----------------------------------------------------
         * CALL LINKEDIN
         * -----------------------------------------------------
         */

        try {

            const controller =
                new AbortController();


            const timeout =
                setTimeout(
                    () => controller.abort(),
                    8000
                );


            const response =
                await fetch(
                    linkedinUrl,
                    {

                        method:
                            "GET",


                        headers:
                            {

                                "User-Agent":
                                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                                    "Chrome/154.0.0.0 Safari/537.36",


                                "Accept":
                                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",


                                "Accept-Language":
                                    "en-US,en;q=0.9",


                                "Referer":
                                    "https://www.linkedin.com/jobs/"

                            },


                        signal:
                            controller.signal

                    }
                );


            clearTimeout(
                timeout
            );


            linkedinStatus =
                response.status;


            /*
             * -------------------------------------------------
             * SUCCESSFUL LINKEDIN RESPONSE
             * -------------------------------------------------
             */

            if (response.ok) {


                const html =
                    await response.text();


                /*
                 * =============================================
                 * PARSE JOB CARDS
                 * =============================================
                 */

                const jobCardRegex =
                    /<li[^>]*>([\s\S]*?base-card[\s\S]*?)<\/li>/gi;


                const cards = [];

                let match;


                while (
                    (
                        match =
                            jobCardRegex.exec(
                                html
                            )
                    ) !== null
                ) {

                    cards.push(
                        match[1]
                    );

                }


                const discoveredJobs = [];


                /*
                 * =============================================
                 * EXTRACT EACH JOB
                 * =============================================
                 */

                for (
                    const card of cards
                ) {


                    /*
                     * Job title
                     */

                    const titleMatch =
                        card.match(
                            /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i
                        );


                    /*
                     * Company
                     */

                    const companyMatch =
                        card.match(
                            /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
                        );


                    /*
                     * Location
                     */

                    const locationMatch =
                        card.match(
                            /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i
                        );


                    /*
                     * LinkedIn job URL
                     */

                    const urlMatch =
                        card.match(
                            /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i
                        );


                    /*
                     * LinkedIn posting timestamp
                     */

                    const timeMatch =
                        card.match(
                            /<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i
                        );


                    /*
                     * LinkedIn Job ID
                     */

                    const idMatch =
                        card.match(
                            /data-entity-urn="urn:li:jobPosting:(\d+)"/i
                        );


                    const jobId =
                        idMatch?.[1] ||
                        "";


                    const title =
                        cleanText(
                            titleMatch?.[1]
                        );


                    const company =
                        cleanText(
                            companyMatch?.[1]
                        );


                    const location =
                        cleanText(
                            locationMatch?.[1]
                        );


                    const posted =
                        cleanText(
                            timeMatch?.[2]
                        );


                    const postedAt =
                        timeMatch?.[1] ||
                        "";


                    const url =
                        cleanUrl(
                            urlMatch?.[1]
                        );


                    /*
                     * -------------------------------------------------
                     * Ignore incomplete jobs
                     * -------------------------------------------------
                     */

                    if (
                        !jobId ||
                        !title ||
                        !company ||
                        !url ||
                        !postedAt
                    ) {

                        continue;

                    }


                    /*
                     * -------------------------------------------------
                     * Validate posting date
                     * -------------------------------------------------
                     */

                    const postedDate =
                        new Date(
                            postedAt
                        );


                    if (
                        isNaN(
                            postedDate.getTime()
                        )
                    ) {

                        continue;

                    }


                    /*
                     * -------------------------------------------------
                     * Don't store jobs older than 30 days
                     * -------------------------------------------------
                     */

                    if (
                        postedDate <
                        cutoff
                    ) {

                        continue;

                    }


                    /*
                     * -------------------------------------------------
                     * Add to discovered jobs
                     * -------------------------------------------------
                     */

                    discoveredJobs.push({

                        jobId:
                            jobId,

                        title:
                            title,

                        company:
                            company,

                        location:
                            location,

                        posted:
                            posted,

                        postedAt:
                            postedDate.toISOString(),

                        url:
                            url,

                        discoveredAt:
                            now.toISOString()

                    });

                }


                /*
                 * =============================================
                 * MERGE WITH EXISTING ARCHIVE
                 * =============================================
                 *
                 * LinkedIn Job ID is used for deduplication.
                 * =============================================
                 */

                const existingIds =
                    new Set(
                        archive.map(
                            job =>
                                job.jobId
                        )
                    );


                for (
                    const job of discoveredJobs
                ) {

                    /*
                     * New job
                     */

                    if (
                        !existingIds.has(
                            job.jobId
                        )
                    ) {

                        archive.push(
                            job
                        );


                        existingIds.add(
                            job.jobId
                        );


                        newlyDiscovered++;

                    }

                }


                /*
                 * =============================================
                 * SAVE UPDATED ARCHIVE
                 * =============================================
                 */

                try {

                    await cache.put(

                        archiveKey,

                        new Response(

                            JSON.stringify(
                                archive
                            ),

                            {
                                status:
                                    200,

                                headers:
                                    {
                                        "Content-Type":
                                            "application/json",

                                        /*
                                         * Cache the archive for
                                         * 30 days.
                                         */
                                        "Cache-Control":
                                            `public, max-age=${ARCHIVE_DAYS * 24 * 60 * 60}`
                                    }
                            }

                        )

                    );

                } catch (error) {

                    console.log(
                        "Archive cache write failed:",
                        error.message
                    );

                }


            } else {


                /*
                 * -------------------------------------------------
                 * LINKEDIN ERROR
                 * -------------------------------------------------
                 */

                linkedinError =
                    `LinkedIn returned HTTP ${response.status}`;

            }


        } catch (error) {

            linkedinError =
                error.message ||
                "LinkedIn request failed";

        }


        /*
         * =====================================================
         * 5. MARK LINKEDIN AS REFRESHED
         * =====================================================
         *
         * This prevents another LinkedIn request for 15 minutes.
         *
         * Even if LinkedIn gives us 429, we don't immediately
         * hammer LinkedIn again.
         * =====================================================
         */

        try {

            await cache.put(

                refreshKey,

                new Response(

                    JSON.stringify({

                        refreshedAt:
                            now.toISOString()

                    }),

                    {

                        status:
                            200,

                        headers:
                            {
                                "Content-Type":
                                    "application/json",

                                "Cache-Control":
                                    `public, max-age=${REFRESH_SECONDS}`
                            }

                    }

                )

            );

        } catch (error) {

            console.log(
                "Refresh marker write failed:",
                error.message
            );

        }

    }


    /*
     * =========================================================
     * 6. FINAL 30-DAY CLEANUP
     * =========================================================
     */

    archive =
        archive.filter(
            job => {

                const postedAt =
                    new Date(
                        job.postedAt
                    );


                return (
                    !isNaN(
                        postedAt.getTime()
                    ) &&
                    postedAt >= cutoff
                );

            }
        );


    /*
     * =========================================================
     * 7. STRICT NEWEST-FIRST SORT
     * =========================================================
     *
     * THIS IS THE IMPORTANT PART.
     *
     * We sort using LinkedIn's actual posting timestamp.
     *
     * NOT:
     * - discovery time
     * - cache time
     * - array position
     * - LinkedIn response order
     *
     * Therefore:
     *
     * 10 minutes ago
     *       ↓
     * 30 minutes ago
     *       ↓
     * 2 hours ago
     *       ↓
     * 1 day ago
     *       ↓
     * 5 days ago
     *
     * =========================================================
     */

    archive.sort(
        (a, b) => {

            const dateA =
                new Date(
                    a.postedAt
                ).getTime();


            const dateB =
                new Date(
                    b.postedAt
                ).getTime();


            return dateB - dateA;

        }
    );


    /*
     * =========================================================
     * 8. RETURN RESULTS
     * =========================================================
     */

    return new Response(

        JSON.stringify({

            success:
                true,

            count:
                archive.length,

            newlyAdded:
                newlyDiscovered,

            retention:
                "30 days",

            refreshInterval:
                "15 minutes",

            sorted:
                "newest first",

            searchProfile:
                [
                    "Corporate Actions",
                    "Reference Data",
                    "Capital Markets",
                    "Asset Servicing",
                    "Trade Settlement",
                    "Business Analyst",
                    "Business Analysis",
                    "Production Support",
                    "Application Support",
                    "L2 Support",
                    "L3 Support",
                    "Production Analyst"
                ],

            linkedin:
                {

                    refreshed:
                        shouldRefresh,

                    status:
                        linkedinStatus,

                    error:
                        linkedinError

                },

            jobs:
                archive

        }),

        {

            status:
                200,

            headers:
                {

                    "Content-Type":
                        "application/json",

                    "Cache-Control":
                        "no-store"

                }

        }

    );

}


/*
 * =========================================================
 * TEXT CLEANING
 * =========================================================
 */

function cleanText(
    value
) {

    if (!value) {

        return "";

    }


    return String(value)

        .replace(
            /<[^>]*>/g,
            " "
        )

        .replace(
            /&amp;/g,
            "&"
        )

        .replace(
            /&quot;/g,
            '"'
        )

        .replace(
            /&#39;/g,
            "'"
        )

        .replace(
            /&nbsp;/g,
            " "
        )

        .replace(
            /&ndash;/g,
            "-"
        )

        .replace(
            /&mdash;/g,
            "-"
        )

        .replace(
            /\s+/g,
            " "
        )

        .trim();

}


/*
 * =========================================================
 * URL CLEANING
 * =========================================================
 */

function cleanUrl(
    value
) {

    if (!value) {

        return "";

    }


    return String(value)

        .replace(
            /&amp;/g,
            "&"
        )

        .trim();

}
