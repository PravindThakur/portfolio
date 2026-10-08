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


    // ==================================================
    // Convert posted-within value to seconds
    // ==================================================

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


    // ==================================================
    // Build LinkedIn guest search URL
    // ==================================================

    const linkedinParams = new URLSearchParams();

    linkedinParams.set("keywords", keywords);
    linkedinParams.set("location", location);
    linkedinParams.set("f_TPR", `r${seconds}`);

    linkedinParams.set(
        "sortBy",
        sort === "newest" ? "DD" : "R"
    );

    // IMPORTANT:
    // Only request the first LinkedIn page.
    // Additional pages can cause HTTP 429.
    linkedinParams.set("start", "0");

    const linkedinUrl =
        "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?" +
        linkedinParams.toString();


    // ==================================================
    // Cloudflare Cache
    // ==================================================

    const cache = caches.default;

    const cacheKey = new Request(
        linkedinUrl,
        {
            method: "GET"
        }
    );

    // 5 minutes
    const CACHE_SECONDS = 300;


    // ==================================================
    // Check cache
    // ==================================================

    try {

        const cachedResponse =
            await cache.match(cacheKey);

        if (cachedResponse) {

            const cachedData =
                await cachedResponse.json();

            // Recalculate match score when returning
            // cached jobs. This allows the scoring logic
            // to change without another LinkedIn request.

            if (cachedData.jobs) {

                cachedData.jobs =
                    cachedData.jobs.map(job =>
                        addMatchScore(job)
                    );
            }

            return new Response(
                JSON.stringify({
                    ...cachedData,
                    cached: true,
                    cacheStatus: "fresh"
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

    } catch (error) {

        console.log(
            "Fresh cache read failed:",
            error.message
        );
    }


    // ==================================================
    // LinkedIn request
    // ==================================================

    async function fetchLinkedIn() {

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

                        signal:
                            controller.signal
                    }
                );

            clearTimeout(timeout);

            return response;

        } catch (error) {

            clearTimeout(timeout);

            throw error;
        }
    }


    // ==================================================
    // Call LinkedIn ONCE
    // ==================================================

    let response = null;

    let lastError = null;

    try {

        response =
            await fetchLinkedIn();

        if (!response.ok) {

            lastError =
                `LinkedIn returned HTTP ${response.status}`;
        }

    } catch (error) {

        lastError =
            error.message ||
            "LinkedIn request failed";
    }


    // ==================================================
    // Handle LinkedIn failure
    // ==================================================

    if (!response || !response.ok) {

        return new Response(
            JSON.stringify({

                success: false,

                error:
                    "LinkedIn temporarily unavailable",

                details:
                    lastError,

                retryable:
                    response?.status === 429,

                status:
                    response?.status || 0

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


    // ==================================================
    // Read LinkedIn HTML
    // ==================================================

    let html;

    try {

        html =
            await response.text();

    } catch (error) {

        return new Response(
            JSON.stringify({

                success: false,

                error:
                    "Unable to read LinkedIn response",

                details:
                    error.message,

                retryable: true

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


    // ==================================================
    // Find LinkedIn job cards
    // ==================================================

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


    // ==================================================
    // Parse jobs
    // ==================================================

    const jobs =
        cards.map(card => {

            // ------------------------------------------
            // Title
            // ------------------------------------------

            const titleMatch =
                card.match(
                    /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i
                );


            // ------------------------------------------
            // Company
            // ------------------------------------------

            const companyMatch =
                card.match(
                    /<h4[^>]*class="[^"]*base-search-card__subtitle[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
                );


            // ------------------------------------------
            // Location
            // ------------------------------------------

            const locationMatch =
                card.match(
                    /<span[^>]*class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i
                );


            // ------------------------------------------
            // LinkedIn URL
            // ------------------------------------------

            const urlMatch =
                card.match(
                    /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i
                );


            // ------------------------------------------
            // Posted time
            // ------------------------------------------

            const timeMatch =
                card.match(
                    /<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i
                );


            // ------------------------------------------
            // LinkedIn Job ID
            // ------------------------------------------

            const idMatch =
                card.match(
                    /data-entity-urn="urn:li:jobPosting:(\d+)"/i
                );


            // ------------------------------------------
            // Job snippet
            // ------------------------------------------

            const snippetMatch =
                card.match(
                    /<p[^>]*class="[^"]*job-search-card__snippet[^"]*"[^>]*>([\s\S]*?)<\/p>/i
                );


            const job = {

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
                    ),

                snippet:
                    cleanText(
                        snippetMatch?.[1]
                    )
            };


            // ------------------------------------------
            // Calculate match score
            // ------------------------------------------

            return addMatchScore(job);
        });


    // ==================================================
    // Remove invalid jobs
    // ==================================================

    const validJobs =
        jobs.filter(job =>
            job.title &&
            job.company &&
            job.url
        );


    // ==================================================
    // Final result
    // ==================================================

    const result = {

        success: true,

        source:
            "LinkedIn guest jobs endpoint",

        cached: false,

        cacheStatus:
            "fresh",

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
            validJobs.length,

        jobs:
            validJobs,

        linkedin: {

            status:
                response.status,

            responseLength:
                html.length
        }
    };


    // ==================================================
    // Save to Cloudflare cache
    // ==================================================

    try {

        const cacheResponse =
            new Response(
                JSON.stringify(result),
                {
                    status: 200,

                    headers: {

                        "Content-Type":
                            "application/json",

                        "Cache-Control":
                            `public, max-age=${CACHE_SECONDS}`
                    }
                }
            );

        context.waitUntil(
            cache.put(
                cacheKey,
                cacheResponse
            )
        );

    } catch (error) {

        console.log(
            "Cache write failed:",
            error.message
        );
    }


    // ==================================================
    // Return response
    // ==================================================

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


// ======================================================
// PROFILE-BASED MATCH SCORE
// ======================================================

function addMatchScore(job) {

    const title =
        normalize(job.title);

    const snippet =
        normalize(job.snippet);

    const company =
        normalize(job.company);

    const location =
        normalize(job.location);

    const text =
        `${title} ${snippet} ${company} ${location}`;


    // ==================================================
    // Your professional profile
    // ==================================================

    const categories = [

        {
            name: "Corporate Actions",
            weight: 20,

            keywords: [
                "corporate action",
                "corporate actions",
                "mand",
                "volu",
                "chos",
                "multi-stage",
                "multistage",
                "dividend",
                "stock split",
                "bonus issue",
                "rights issue",
                "entitlement"
            ]
        },

        {
            name: "Reference Data",
            weight: 20,

            keywords: [
                "reference data",
                "reference-data",
                "static data",
                "static-data",
                "security master",
                "security master data",
                "business partner data",
                "instrument data",
                "master data"
            ]
        },

        {
            name: "Capital Markets",
            weight: 15,

            keywords: [
                "capital markets",
                "capital market",
                "securities",
                "securities processing",
                "investment banking",
                "financial markets"
            ]
        },

        {
            name: "Trade Settlement",
            weight: 10,

            keywords: [
                "trade settlement",
                "settlement",
                "trade lifecycle",
                "trade life cycle",
                "dvp",
                "rvp",
                "dfp",
                "rfp"
            ]
        },

        {
            name: "Asset Servicing",
            weight: 10,

            keywords: [
                "asset servicing",
                "asset service",
                "securities services",
                "custody",
                "custodian",
                "corporate services"
            ]
        },

        {
            name: "Production Support",
            weight: 10,

            keywords: [
                "production support",
                "application support",
                "l2 support",
                "l3 support",
                "level 2 support",
                "level 3 support",
                "incident management",
                "problem management",
                "root cause analysis",
                "rca",
                "production"
            ]
        },

        {
            name: "Business Analysis",
            weight: 10,

            keywords: [
                "business analyst",
                "business analysis",
                "senior business analyst",
                "requirements",
                "requirement gathering",
                "requirements analysis",
                "functional analysis",
                "functional analyst",
                "business requirements",
                "stakeholder management"
            ]
        },

        {
            name: "SQL",
            weight: 3,

            keywords: [
                "sql",
                "oracle sql",
                "plsql",
                "pl/sql",
                "database",
                "oracle"
            ]
        },

        {
            name: "SWIFT",
            weight: 2,

            keywords: [
                "swift",
                "mt564",
                "mt565",
                "mt566",
                "mt567",
                "iso 20022"
            ]
        }
    ];


    // ==================================================
    // Calculate category matches
    // ==================================================

    const matchedSkills = [];

    let score = 0;


    for (const category of categories) {

        let matched = false;

        for (const keyword of category.keywords) {

            if (text.includes(keyword)) {

                matched = true;
                break;
            }
        }

        if (matched) {

            score += category.weight;

            matchedSkills.push(
                category.name
            );
        }
    }


    // ==================================================
    // Strong title bonuses
    // ==================================================

    let titleBonus = 0;

    if (
        title.includes("business analyst")
    ) {

        titleBonus += 5;
    }

    if (
        title.includes("reference data")
    ) {

        titleBonus += 5;
    }

    if (
        title.includes("corporate action")
    ) {

        titleBonus += 5;
    }

    if (
        title.includes("capital market")
    ) {

        titleBonus += 5;
    }

    if (
        title.includes("asset servicing")
    ) {

        titleBonus += 5;
    }


    // Maximum title bonus = 5
    // Avoid allowing the bonus to push
    // score beyond 100.

    titleBonus =
        Math.min(titleBonus, 5);


    score += titleBonus;


    // ==================================================
    // Relevance adjustment
    // ==================================================

    // A completely unrelated role should not appear
    // as highly matched simply because it contains
    // "SQL" or "Oracle".

    const strongCategories =
        [
            "Corporate Actions",
            "Reference Data",
            "Capital Markets",
            "Trade Settlement",
            "Asset Servicing",
            "Business Analysis"
        ];

    const strongMatchCount =
        matchedSkills.filter(skill =>
            strongCategories.includes(skill)
        ).length;


    if (
        strongMatchCount === 0 &&
        score > 20
    ) {

        score = 20;
    }


    // ==================================================
    // Cap score
    // ==================================================

    score =
        Math.min(
            Math.round(score),
            100
        );


    // ==================================================
    // Match level
    // ==================================================

    let matchLevel;

    if (score >= 80) {

        matchLevel = "Excellent";

    } else if (score >= 65) {

        matchLevel = "Strong";

    } else if (score >= 45) {

        matchLevel = "Good";

    } else if (score >= 25) {

        matchLevel = "Moderate";

    } else {

        matchLevel = "Low";
    }


    // ==================================================
    // Return enhanced job
    // ==================================================

    return {

        ...job,

        matchScore: score,

        matchLevel: matchLevel,

        matchedSkills: matchedSkills
    };
}


// ======================================================
// Normalize text
// ======================================================

function normalize(value) {

    if (!value) {
        return "";
    }

    return String(value)
        .toLowerCase()
        .replace(
            /[\u2013\u2014]/g,
            "-"
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}


// ======================================================
// Clean HTML/text
// ======================================================

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


// ======================================================
// Clean LinkedIn URL
// ======================================================

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
