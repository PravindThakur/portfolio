export async function onRequestGet(context) {

    const requestUrl = new URL(context.request.url);

    const keywords =
        requestUrl.searchParams.get("keywords") ||
        "Business Analyst";

    const location =
        requestUrl.searchParams.get("location") ||
        "India";

    const timeValue =
        Number(requestUrl.searchParams.get("timeValue")) || 60;

    const timeUnit =
        requestUrl.searchParams.get("timeUnit") || "minutes";

    const sort =
        requestUrl.searchParams.get("sort") || "newest";

    const workplace =
        requestUrl.searchParams.get("workplace") || "";

    const skills =
        requestUrl.searchParams.get("skills") || "";


    // --------------------------------------------------
    // Convert posted-within value to seconds
    // --------------------------------------------------

    let seconds = timeValue;

    if (timeUnit === "minutes") {
        seconds = timeValue * 60;
    }

    if (timeUnit === "hours") {
        seconds = timeValue * 60 * 60;
    }

    if (timeUnit === "days") {
        seconds = timeValue * 24 * 60 * 60;
    }


    // --------------------------------------------------
    // LinkedIn search URL
    // --------------------------------------------------

    const linkedinParams = new URLSearchParams();

    linkedinParams.set("keywords", keywords);
    linkedinParams.set("location", location);
    linkedinParams.set("f_TPR", `r${seconds}`);
    linkedinParams.set(
        "sortBy",
        sort === "newest" ? "DD" : "R"
    );


    // --------------------------------------------------
    // Cache configuration
    // --------------------------------------------------

    const CACHE_SECONDS = 120;

    const cache = caches.default;


    // --------------------------------------------------
    // Fetch up to 50 jobs
    // --------------------------------------------------

    const MAX_JOBS = 50;
    const JOBS_PER_REQUEST = 10;

    const allJobs = [];

    let lastLinkedInStatus = 200;
    let totalResponseLength = 0;


    // --------------------------------------------------
    // Fetch one LinkedIn page with timeout
    // --------------------------------------------------

    async function fetchLinkedInPage(start) {

        linkedinParams.set("start", String(start));

        const linkedinUrl =
            "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
            linkedinParams.toString();


        const cacheKey = new Request(
            linkedinUrl,
            {
                method: "GET"
            }
        );


        // ----------------------------------------------
        // Check cache first
        // ----------------------------------------------

        try {

            const cachedResponse =
                await cache.match(cacheKey);

            if (cachedResponse) {

                const cachedData =
                    await cachedResponse.json();

                return {
                    jobs: cachedData.jobs || [],
                    cached: true,
                    status: 200,
                    responseLength:
                        cachedData.responseLength || 0
                };
            }

        } catch (error) {

            console.log(
                "Cache read failed:",
                error.message
            );

        }


        // ----------------------------------------------
        // LinkedIn request
        // ----------------------------------------------

        async function requestLinkedIn() {

            const controller =
                new AbortController();

            const timeout =
                setTimeout(
                    () => controller.abort(),
                    8000
                );


            try {

                const response =
                    await fetch(
                        linkedinUrl,
                        {
                            method: "GET",

                            headers: {

                                "User-Agent":
                                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",

                                "Accept":
                                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                                "Accept-Language":
                                    "en-US,en;q=0.9",

                                "Referer":
                                    "https://www.linkedin.com/jobs/"
                            },

                            signal: controller.signal
                        }
                    );


                clearTimeout(timeout);

                return response;

            } catch (error) {

                clearTimeout(timeout);

                throw error;

            }

        }


        // ----------------------------------------------
        // Retry twice
        // ----------------------------------------------

        let response = null;
        let lastError = null;


        for (
            let attempt = 1;
            attempt <= 2;
            attempt++
        ) {

            try {

                response =
                    await requestLinkedIn();


                if (response.ok) {
                    break;
                }


                lastError =
                    `LinkedIn returned HTTP ${response.status}`;

            } catch (error) {

                lastError =
                    error.message ||
                    "LinkedIn request failed";
            }


            if (attempt === 1) {

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            700
                        )
                );

            }

        }


        if (!response || !response.ok) {

            throw new Error(
                lastError ||
                "LinkedIn temporarily unavailable"
            );

        }


        // ----------------------------------------------
        // Read HTML
        // ----------------------------------------------

        const html =
            await response.text();


        lastLinkedInStatus =
            response.status;

        totalResponseLength +=
            html.length;


        // ----------------------------------------------
        // Parse job cards
        // ----------------------------------------------

        const jobCardRegex =
            /<li[^>]*>([\s\S]*?base-card[\s\S]*?)<\/li>/gi;


        const cards = [];

        let match;


        while (
            (match =
                jobCardRegex.exec(html)) !== null
        ) {

            cards.push(match[1]);

        }


        const jobs =
            cards.map(card => {

                const titleMatch =
                    card.match(
                        /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i
                    );


                const companyMatch =
                    card.match(
                        /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
                    );


                const locationMatch =
                    card.match(
                        /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i
                    );


                const urlMatch =
                    card.match(
                        /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i
                    );


                const timeMatch =
                    card.match(
                        /<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i
                    );


                const idMatch =
                    card.match(
                        /data-entity-urn="urn:li:jobPosting:(\d+)"/i
                    );


                return {

                    title:
                        cleanText(
                            titleMatch?.[1]
                        ),

                    company:
                        cleanText(
                            companyMatch?.[1]
                        ),

                    location:
                        cleanText(
                            locationMatch?.[1]
                        ),

                    posted:
                        cleanText(
                            timeMatch?.[2]
                        ),

                    postedAt:
                        timeMatch?.[1] || "",

                    jobId:
                        idMatch?.[1] || "",

                    url:
                        cleanUrl(
                            urlMatch?.[1]
                        )
                };

            });


        return {
            jobs: jobs.filter(
                job =>
                    job.title &&
                    job.company &&
                    job.url
            ),

            cached: false,

            status:
                response.status,

            responseLength:
                html.length,

            cacheKey
        };

    }


    // --------------------------------------------------
    // Fetch pages: 0, 10, 20, 30, 40
    // --------------------------------------------------

    try {

        for (
            let start = 0;
            start < MAX_JOBS;
            start += JOBS_PER_REQUEST
        ) {

            const page =
                await fetchLinkedInPage(start);


            allJobs.push(
                ...page.jobs
            );


            // Stop if LinkedIn returns fewer than
            // 10 jobs. This means there are no more
            // results available.

            if (
                page.jobs.length <
                JOBS_PER_REQUEST
            ) {

                break;

            }

        }

    } catch (error) {

        return new Response(

            JSON.stringify({

                success: false,

                error:
                    "LinkedIn temporarily unavailable",

                details:
                    error.message,

                retryable:
                    true

            }),

            {

                status: 200,

                headers: {

                    "Content-Type":
                        "application/json",

                    "Cache-Control":
                        "no-store"

                }

            }

        );

    }


    // --------------------------------------------------
    // Remove duplicate jobs
    // --------------------------------------------------

    const uniqueJobs =
        Array.from(

            new Map(

                allJobs.map(job => [

                    job.jobId ||
                    job.url,

                    job

                ])

            ).values()

        );


    // --------------------------------------------------
    // Limit to 50
    // --------------------------------------------------

    const finalJobs =
        uniqueJobs.slice(
            0,
            MAX_JOBS
        );


    // --------------------------------------------------
    // Final result
    // --------------------------------------------------

    const result = {

        success: true,

        source:
            "LinkedIn guest jobs endpoint",

        cached: false,

        search: {

            keywords,

            location,

            timeValue,

            timeUnit,

            seconds,

            workplace:
                workplace
                    ? workplace.split(",")
                    : [],

            skills:
                skills
                    ? skills.split(",")
                    : [],

            sort

        },

        count:
            finalJobs.length,

        jobs:
            finalJobs,

        linkedin: {

            status:
                lastLinkedInStatus,

            pagesRequested:
                Math.ceil(
                    finalJobs.length /
                    JOBS_PER_REQUEST
                ),

            responseLength:
                totalResponseLength

        }

    };


    return new Response(

        JSON.stringify(result),

        {

            status: 200,

            headers: {

                "Content-Type":
                    "application/json",

                "Cache-Control":
                    "no-store"

            }

        }

    );

}


// --------------------------------------------------
// Helpers
// --------------------------------------------------

function cleanText(value) {

    if (!value) {
        return "";
    }


    return value

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
            /\s+/g,
            " "
        )

        .trim();

}


function cleanUrl(value) {

    if (!value) {
        return "";
    }


    return value

        .replace(
            /&amp;/g,
            "&"
        )

        .trim();

}
