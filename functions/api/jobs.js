/**
 * Cloudflare Pages Function
 *
 * Purpose:
 * - Fetch relevant LinkedIn jobs for India
 * - Keep a rolling 30-day archive
 * - Refresh LinkedIn at most once every 15 minutes
 * - Deduplicate jobs by LinkedIn Job ID
 * - Sort strictly by LinkedIn postedAt
 * - Automatically remove jobs older than 30 days
 *
 * No D1 database required.
 * Uses Cloudflare Cache API.
 */

const ARCHIVE_DAYS = 30;

const REFRESH_MINUTES = 15;
const REFRESH_SECONDS = REFRESH_MINUTES * 60;

const ARCHIVE_CACHE_KEY =
    "https://pravindthakur.com/__job_archive_v3";

const REFRESH_CACHE_KEY =
    "https://pravindthakur.com/__job_refresh_v3";

const LINKEDIN_URL =
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";


export async function onRequestGet(context) {

    const request =
        context.request;

    const cache =
        caches.default;

    const now =
        new Date();

    const cutoffTime =
        now.getTime() -
        ARCHIVE_DAYS *
        24 *
        60 *
        60 *
        1000;


    /*
     * ---------------------------------------------------------
     * 1. Read existing archive
     * ---------------------------------------------------------
     */

    let archiveData = {
        jobs: [],
        refreshedAt: null
    };


    try {

        const archiveResponse =
            await cache.match(
                ARCHIVE_CACHE_KEY
            );


        if (archiveResponse) {

            const parsed =
                await archiveResponse.json();


            /*
             * Support both the new object format
             * and the older array format.
             */

            if (
                Array.isArray(parsed)
            ) {

                archiveData.jobs =
                    parsed;

            } else {

                archiveData.jobs =
                    Array.isArray(parsed.jobs)
                        ? parsed.jobs
                        : [];

                archiveData.refreshedAt =
                    parsed.refreshedAt ||
                    null;

            }

        }

    } catch (error) {

        console.error(
            "Archive read error:",
            error
        );

    }


    let jobs =
        archiveData.jobs || [];


    let refreshedAt =
        archiveData.refreshedAt || null;


    /*
     * ---------------------------------------------------------
     * 2. Remove jobs older than 30 days
     * ---------------------------------------------------------
     */

    jobs =
        jobs.filter(
            job => {

                const postedTime =
                    new Date(
                        job.postedAt || 0
                    ).getTime();


                return (
                    postedTime >=
                    cutoffTime
                );

            }
        );


    /*
     * ---------------------------------------------------------
     * 3. Check whether LinkedIn refresh is required
     * ---------------------------------------------------------
     */

    let shouldRefresh =
        true;


    try {

        const refreshResponse =
            await cache.match(
                REFRESH_CACHE_KEY
            );


        if (refreshResponse) {

            shouldRefresh =
                false;

        }

    } catch (error) {

        console.error(
            "Refresh marker error:",
            error
        );

    }


    let newlyAdded =
        0;

    let linkedinStatus =
        "not_refreshed";


    /*
     * ---------------------------------------------------------
     * 4. Refresh LinkedIn if required
     * ---------------------------------------------------------
     */

    if (shouldRefresh) {

        linkedinStatus =
            "refreshing";


        try {

            const keywords =
                "Corporate Actions OR " +
                "Reference Data OR " +
                "Capital Markets OR " +
                "Asset Servicing OR " +
                "Trade Settlement OR " +
                "\"Business Analyst\" OR " +
                "\"Business Analysis\" OR " +
                "\"Production Support\" OR " +
                "\"Application Support\" OR " +
                "\"L2 Support\" OR " +
                "\"L3 Support\" OR " +
                "\"Production Analyst\"";


            const params =
                new URLSearchParams({

                    keywords,
                    location: "India",

                    f_TPR:
                        "r2592000",

                    sortBy:
                        "DD",

                    start:
                        "0"

                });


            const linkedinUrl =
                `${LINKEDIN_URL}?${params.toString()}`;


            const controller =
                new AbortController();


            const timeout =
                setTimeout(
                    () => {
                        controller.abort();
                    },
                    8000
                );


            const linkedinResponse =
                await fetch(
                    linkedinUrl,
                    {

                        method: "GET",

                        headers: {

                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",

                            "Accept":
                                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

                            "Accept-Language":
                                "en-US,en;q=0.9",

                            "Cache-Control":
                                "no-cache",

                            "Pragma":
                                "no-cache"

                        },

                        signal:
                            controller.signal

                    }
                );


            clearTimeout(
                timeout
            );


            if (
                !linkedinResponse.ok
            ) {

                throw new Error(
                    `LinkedIn HTTP ${linkedinResponse.status}`
                );

            }


            const html =
                await linkedinResponse.text();


            const fetchedJobs =
                parseLinkedInJobs(
                    html
                );


            /*
             * -------------------------------------------------
             * Merge jobs
             * -------------------------------------------------
             */

            const existingIds =
                new Set(
                    jobs
                        .map(
                            job =>
                                String(
                                    job.jobId
                                )
                        )
                );


            for (
                const job of fetchedJobs
            ) {

                const postedTime =
                    new Date(
                        job.postedAt
                    ).getTime();


                /*
                 * Ignore jobs outside
                 * the 30-day window.
                 */

                if (
                    !Number.isFinite(
                        postedTime
                    )
                ) {

                    continue;

                }


                if (
                    postedTime <
                    cutoffTime
                ) {

                    continue;

                }


                const jobId =
                    String(
                        job.jobId
                    );


                if (
                    existingIds.has(
                        jobId
                    )
                ) {

                    continue;

                }


                jobs.push(
                    job
                );

                existingIds.add(
                    jobId
                );

                newlyAdded++;

            }


            /*
             * LinkedIn was successfully
             * refreshed.
             */

            refreshedAt =
                new Date().toISOString();


            linkedinStatus =
                "success";


            /*
             * -------------------------------------------------
             * Save refresh marker
             * -------------------------------------------------
             *
             * This prevents repeated LinkedIn
             * requests for 15 minutes.
             */

            const refreshMarker =
                new Response(
                    JSON.stringify({

                        refreshedAt

                    }),
                    {

                        headers: {

                            "Content-Type":
                                "application/json",

                            "Cache-Control":
                                `public, max-age=${REFRESH_SECONDS}`

                        }

                    }
                );


            await cache.put(
                REFRESH_CACHE_KEY,
                refreshMarker
            );


        } catch (error) {

            console.error(
                "LinkedIn refresh error:",
                error
            );


            linkedinStatus =
                "error";


            /*
             * Even if LinkedIn fails,
             * create a 15-minute marker.
             *
             * This prevents the website
             * from hammering LinkedIn.
             */

            const refreshMarker =
                new Response(
                    JSON.stringify({

                        attemptedAt:
                            new Date().toISOString(),

                        error:
                            String(
                                error.message ||
                                error
                            )

                    }),
                    {

                        headers: {

                            "Content-Type":
                                "application/json",

                            "Cache-Control":
                                `public, max-age=${REFRESH_SECONDS}`

                        }

                    }
                );


            await cache.put(
                REFRESH_CACHE_KEY,
                refreshMarker
            );

        }

    } else {

        linkedinStatus =
            "cached";

    }


    /*
     * ---------------------------------------------------------
     * 5. Final 30-day cleanup
     * ---------------------------------------------------------
     */

    jobs =
        jobs.filter(
            job => {

                const postedTime =
                    new Date(
                        job.postedAt || 0
                    ).getTime();


                return (
                    Number.isFinite(
                        postedTime
                    ) &&
                    postedTime >=
                    cutoffTime
                );

            }
        );


    /*
     * ---------------------------------------------------------
     * 6. Deduplicate again
     * ---------------------------------------------------------
     */

    const uniqueJobs =
        new Map();


    for (
        const job of jobs
    ) {

        if (
            !job ||
            !job.jobId
        ) {

            continue;

        }


        uniqueJobs.set(
            String(
                job.jobId
            ),
            job
        );

    }


    jobs =
        Array.from(
            uniqueJobs.values()
        );


    /*
     * ---------------------------------------------------------
     * 7. Sort strictly by actual LinkedIn postedAt
     * ---------------------------------------------------------
     */

    jobs.sort(
        (
            a,
            b
        ) => {

            const dateA =
                new Date(
                    a.postedAt || 0
                ).getTime();


            const dateB =
                new Date(
                    b.postedAt || 0
                ).getTime();


            return dateB - dateA;

        }
    );


    /*
     * ---------------------------------------------------------
     * 8. Save archive
     * ---------------------------------------------------------
     */

    const archivePayload = {

        jobs,

        refreshedAt

    };


    try {

        const archiveResponse =
            new Response(
                JSON.stringify(
                    archivePayload
                ),
                {

                    headers: {

                        "Content-Type":
                            "application/json",

                        "Cache-Control":
                            `public, max-age=${ARCHIVE_DAYS * 24 * 60 * 60}`

                    }

                }
            );


        await cache.put(
            ARCHIVE_CACHE_KEY,
            archiveResponse
        );


    } catch (error) {

        console.error(
            "Archive save error:",
            error
        );

    }


    /*
     * ---------------------------------------------------------
     * 9. Return response
     * ---------------------------------------------------------
     */

    return new Response(

        JSON.stringify({

            success:
                true,

            count:
                jobs.length,

            newlyAdded,

            retention:
                "30 days",

            refreshIntervalMinutes:
                REFRESH_MINUTES,

            refreshedAt,

            nextRefreshInMinutes:
                REFRESH_MINUTES,

            sorted:
                "postedAt descending",

            searchProfile: {

                location:
                    "India",

                keywords: [
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
                ]

            },

            linkedin:
                linkedinStatus,

            jobs

        }),

        {

            status: 200,

            headers: {

                "Content-Type":
                    "application/json",

                "Cache-Control":
                    "no-store, no-cache, must-revalidate"

            }

        }

    );

}


/*
 * ============================================================
 * LinkedIn HTML parser
 * ============================================================
 */

function parseLinkedInJobs(
    html
) {

    const jobs = [];


    /*
     * LinkedIn guest endpoint returns
     * job cards inside <li> elements.
     */

    const cardRegex =
        /<li[\s\S]*?base-card[\s\S]*?<\/li>/gi;


    const cards =
        html.match(
            cardRegex
        ) || [];


    for (
        const card of cards
    ) {

        try {

            /*
             * Job ID
             */

            const idMatch =
                card.match(
                    /data-entity-urn="urn:li:jobPosting:(\d+)"/i
                );


            if (
                !idMatch
            ) {

                continue;

            }


            const jobId =
                idMatch[1];


            /*
             * Job title
             */

            const titleMatch =
                card.match(
                    /base-search-card__title[^>]*>([\s\S]*?)<\/h3>/i
                );


            const title =
                cleanText(
                    titleMatch
                        ? titleMatch[1]
                        : ""
                );


            /*
             * Company
             */

            const companyMatch =
                card.match(
                    /base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/i
                );


            const company =
                cleanText(
                    companyMatch
                        ? companyMatch[1]
                        : ""
                );


            /*
             * Location
             */

            const locationMatch =
                card.match(
                    /job-search-card__location[^>]*>([\s\S]*?)<\/span>/i
                );


            const location =
                cleanText(
                    locationMatch
                        ? locationMatch[1]
                        : ""
                );


            /*
             * Posted text
             */

            const postedMatch =
                card.match(
                    /date[^>]*>([\s\S]*?)<\/time>/i
                );


            const posted =
                cleanText(
                    postedMatch
                        ? postedMatch[1]
                        : ""
                );


            /*
             * URL
             */

            const urlMatch =
                card.match(
                    /base-card__full-link[^>]*href="([^"]+)"/i
                );


            let url =
                urlMatch
                    ? urlMatch[1]
                    : "";


            url =
                cleanUrl(
                    url
                );


            /*
             * Normalize LinkedIn relative URLs.
             */

            if (
                url &&
                url.startsWith("/")
            ) {

                url =
                    "https://www.linkedin.com" +
                    url;

            }


            /*
             * Convert LinkedIn relative
             * posted text into timestamp.
             */

            const postedAt =
                normalizePostedDate(
                    posted
                );


            /*
             * Ignore incomplete records.
             */

            if (
                !jobId ||
                !title ||
                !company ||
                !postedAt
            ) {

                continue;

            }


            jobs.push({

                jobId,

                title,

                company,

                location,

                posted,

                postedAt,

                url,

                discoveredAt:
                    new Date().toISOString()

            });


        } catch (error) {

            console.error(
                "Card parsing error:",
                error
            );

        }

    }


    return jobs;

}


/*
 * ============================================================
 * Convert LinkedIn "2 days ago", "1 week ago", etc.
 * to an ISO timestamp.
 * ============================================================
 */

function normalizePostedDate(
    posted
) {

    if (
        !posted
    ) {

        return null;

    }


    const value =
        posted
            .toLowerCase()
            .trim();


    const now =
        Date.now();


    /*
     * Just now
     */

    if (
        value.includes("just now")
    ) {

        return new Date(
            now
        ).toISOString();

    }


    /*
     * Minutes
     */

    const minuteMatch =
        value.match(
            /(\d+)\s*minute/
        );


    if (
        minuteMatch
    ) {

        return new Date(
            now -
            Number(
                minuteMatch[1]
            ) *
            60 *
            1000
        ).toISOString();

    }


    /*
     * Hours
     */

    const hourMatch =
        value.match(
            /(\d+)\s*hour/
        );


    if (
        hourMatch
    ) {

        return new Date(
            now -
            Number(
                hourMatch[1]
            ) *
            60 *
            60 *
            1000
        ).toISOString();

    }


    /*
     * Days
     */

    const dayMatch =
        value.match(
            /(\d+)\s*day/
        );


    if (
        dayMatch
    ) {

        return new Date(
            now -
            Number(
                dayMatch[1]
            ) *
            24 *
            60 *
            60 *
            1000
        ).toISOString();

    }


    /*
     * Weeks
     */

    const weekMatch =
        value.match(
            /(\d+)\s*week/
        );


    if (
        weekMatch
    ) {

        return new Date(
            now -
            Number(
                weekMatch[1]
            ) *
            7 *
            24 *
            60 *
            60 *
            1000
        ).toISOString();

    }


    /*
     * Months
     */

    const monthMatch =
        value.match(
            /(\d+)\s*month/
        );


    if (
        monthMatch
    ) {

        return new Date(
            now -
            Number(
                monthMatch[1]
            ) *
            30 *
            24 *
            60 *
            60 *
            1000
        ).toISOString();

    }


    /*
     * LinkedIn sometimes returns
     * "30+ days ago".
     */

    if (
        value.includes("30+")
    ) {

        return new Date(
            now -
            31 *
            24 *
            60 *
            60 *
            1000
        ).toISOString();

    }


    return null;

}


/*
 * ============================================================
 * Clean HTML text
 * ============================================================
 */

function cleanText(
    value
) {

    if (
        !value
    ) {

        return "";

    }


    return String(
        value
    )
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
            /&apos;/g,
            "'"
        )
        .replace(
            /&nbsp;/g,
            " "
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();

}


/*
 * ============================================================
 * Clean URL
 * ============================================================
 */

function cleanUrl(
    value
) {

    if (
        !value
    ) {

        return "";

    }


    return String(
        value
    )
        .replace(
            /&amp;/g,
            "&"
        )
        .replace(
            /\\u002F/g,
            "/"
        )
        .trim();

}
