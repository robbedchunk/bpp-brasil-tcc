--
-- PostgreSQL database dump
--

--\ restrict P6V4WxaauxPaZZn7LQolQpwZAM9gOdnjhYZjsedhEs2v2PtLhGQ1dtN3dCnh4Cr -- Dumped from database version 16.10
-- Dumped by pg_dump version 16.10
-- Started on 2025-11-05 23:52:05 UTC
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;
SET default_tablespace = '';
SET default_table_access_method = heap;
--
-- TOC entry 220 (class 1259 OID 16415)
-- Name: brand; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.brand (
    id integer NOT NULL,
    name text NOT NULL,
    canonical text,
    origin text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.brand OWNER TO postgres;
--
-- TOC entry 219 (class 1259 OID 16414)
-- Name: brand_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.brand_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.brand_id_seq OWNER TO postgres;
--
-- TOC entry 3582 (class 0 OID 0)
-- Dependencies: 219
-- Name: brand_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.brand_id_seq OWNED BY public.brand.id;
--
-- TOC entry 222 (class 1259 OID 16427)
-- Name: category; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.category (
    id integer NOT NULL,
    "parentId" bigint,
    store_id integer NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL
);
ALTER TABLE public.category OWNER TO postgres;
--
-- TOC entry 221 (class 1259 OID 16426)
-- Name: category_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.category_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.category_id_seq OWNER TO postgres;
--
-- TOC entry 3583 (class 0 OID 0)
-- Dependencies: 221
-- Name: category_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.category_id_seq OWNED BY public.category.id;
--
-- TOC entry 242 (class 1259 OID 16560)
-- Name: daily_market_index; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.daily_market_index (
    day date NOT NULL,
    "countryCode" character(2),
    "zipCode" character varying(20),
    "indexLevel" numeric,
    method text,
    meta jsonb
);
ALTER TABLE public.daily_market_index OWNER TO postgres;
--
-- TOC entry 241 (class 1259 OID 16551)
-- Name: daily_price_aggregate; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.daily_price_aggregate (
    day date NOT NULL,
    "minPrice" numeric,
    "maxPrice" numeric,
    id integer NOT NULL,
    "regionId" integer,
    "categoryId" integer,
    "avgPrice" numeric,
    "itemCount" numeric,
    meta jsonb
);
ALTER TABLE public.daily_price_aggregate OWNER TO postgres;
--
-- TOC entry 245 (class 1259 OID 16703)
-- Name: daily_price_aggregate_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.daily_price_aggregate_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.daily_price_aggregate_id_seq OWNER TO postgres;
--
-- TOC entry 3584 (class 0 OID 0)
-- Dependencies: 245
-- Name: daily_price_aggregate_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.daily_price_aggregate_id_seq OWNED BY public.daily_price_aggregate.id;
--
-- TOC entry 236 (class 1259 OID 16514)
-- Name: extraction_model; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.extraction_model (
    id integer NOT NULL,
    name text,
    version text,
    parameters jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL
);
ALTER TABLE public.extraction_model OWNER TO postgres;
--
-- TOC entry 235 (class 1259 OID 16513)
-- Name: extraction_model_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.extraction_model_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.extraction_model_id_seq OWNER TO postgres;
--
-- TOC entry 3585 (class 0 OID 0)
-- Dependencies: 235
-- Name: extraction_model_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.extraction_model_id_seq OWNED BY public.extraction_model.id;
--
-- TOC entry 243 (class 1259 OID 16568)
-- Name: fx_rate; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.fx_rate (
    rate numeric(12, 6) NOT NULL,
    id integer NOT NULL,
    day date NOT NULL,
    "baseCurrency" character(3) NOT NULL,
    "quoteCurrency" character(3) NOT NULL,
    source text,
    meta jsonb
);
ALTER TABLE public.fx_rate OWNER TO postgres;
--
-- TOC entry 244 (class 1259 OID 16683)
-- Name: fx_rate_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.fx_rate_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.fx_rate_id_seq OWNER TO postgres;
--
-- TOC entry 3586 (class 0 OID 0)
-- Dependencies: 244
-- Name: fx_rate_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.fx_rate_id_seq OWNED BY public.fx_rate.id;
--
-- TOC entry 238 (class 1259 OID 16524)
-- Name: price_observation; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.price_observation (
    id integer NOT NULL,
    product_id integer NOT NULL,
    store_id integer NOT NULL,
    region_id integer,
    scrape_id integer,
    extraction_model_id integer,
    "observedAt" timestamp with time zone NOT NULL,
    price numeric NOT NULL,
    currency character(3) NOT NULL,
    "isPromo" boolean DEFAULT false NOT NULL,
    "priceBefore" numeric,
    shipping numeric,
    "taxIncluded" boolean DEFAULT false NOT NULL,
    seller text,
    "sourceUrl" text NOT NULL,
    "htmlSnapshot" text,
    "snapshotHash" text,
    "normalizedPrice" numeric,
    "priceUnit" text,
    "unitValue" numeric,
    "unitMeasure" text,
    "matchedConfidence" numeric,
    "extractionMeta" jsonb,
    "botDetectionMeta" jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "configVersion" character varying(50),
    availability boolean
);
ALTER TABLE public.price_observation OWNER TO postgres;
--
-- TOC entry 237 (class 1259 OID 16523)
-- Name: price_observation_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.price_observation_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.price_observation_id_seq OWNER TO postgres;
--
-- TOC entry 3587 (class 0 OID 0)
-- Dependencies: 237
-- Name: price_observation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.price_observation_id_seq OWNED BY public.price_observation.id;
--
-- TOC entry 224 (class 1259 OID 16438)
-- Name: product; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.product (
    id integer NOT NULL,
    category_id integer NOT NULL,
    store_id integer NOT NULL,
    brand_id integer,
    sku text,
    upc text,
    gtin text,
    name text NOT NULL,
    "canonicalName" text,
    "alternateNames" text [],
    description text,
    "quantityValue" numeric,
    "quantityUnit" text,
    attributes jsonb,
    "imageUrl" text,
    "productUrl" text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.product OWNER TO postgres;
--
-- TOC entry 223 (class 1259 OID 16437)
-- Name: product_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.product_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.product_id_seq OWNER TO postgres;
--
-- TOC entry 3588 (class 0 OID 0)
-- Dependencies: 223
-- Name: product_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.product_id_seq OWNED BY public.product.id;
--
-- TOC entry 240 (class 1259 OID 16542)
-- Name: product_link; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.product_link (
    id integer NOT NULL,
    product_id integer NOT NULL,
    linked_product_id integer NOT NULL,
    type character varying(50),
    source character varying(50),
    "linkedAt" timestamp without time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.product_link OWNER TO postgres;
--
-- TOC entry 239 (class 1259 OID 16541)
-- Name: product_link_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.product_link_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.product_link_id_seq OWNER TO postgres;
--
-- TOC entry 3589 (class 0 OID 0)
-- Dependencies: 239
-- Name: product_link_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.product_link_id_seq OWNED BY public.product_link.id;
--
-- TOC entry 232 (class 1259 OID 16489)
-- Name: proxy; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.proxy (
    id integer NOT NULL,
    ip text,
    port integer,
    username text,
    pass text,
    country varchar(2),
    type text,
    active integer default 1,
    success_count integer DEFAULT 0,
    failure_count integer DEFAULT 0,
    total_requests integer DEFAULT 0,
    error_count integer DEFAULT 0,
    last_status text,
    last_used timestamp with time zone DEFAULT now(),
);
ALTER TABLE public.proxy OWNER TO postgres;
ALTER TABLE public.proxy
ADD CONSTRAINT unique_ip_port UNIQUE (ip, port);
--
-- TOC entry 231 (class 1259 OID 16488)
-- Name: proxy_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.proxy_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.proxy_id_seq OWNER TO postgres;
--
-- TOC entry 3590 (class 0 OID 0)
-- Dependencies: 231
-- Name: proxy_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.proxy_id_seq OWNED BY public.proxy.id;
--
-- TOC entry 218 (class 1259 OID 16404)
-- Name: region; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE proxy_usage_log (
    id SERIAL PRIMARY KEY,
    proxy_id INT REFERENCES proxy(id) ON DELETE CASCADE,
    scrape_job_id INT REFERENCES scrape_job(id) ON DELETE
    SET NULL,
        used_at TIMESTAMPTZ DEFAULT now() NOT NULL,
        status TEXT,
        -- 'success' | 'fail'
        response_code INT,
        latency_ms INT,
        url TEXT,
        message TEXT
);
CREATE INDEX idx_proxy_usage_proxy ON proxy_usage_log(proxy_id);
CREATE INDEX idx_proxy_usage_time ON proxy_usage_log(used_at);
CREATE TABLE public.region (
    id integer NOT NULL,
    name text NOT NULL,
    "countryCode" character(2) NOT NULL,
    "zipCode" text,
    active boolean DEFAULT true NOT NULL
);
ALTER TABLE public.region OWNER TO postgres;
--
-- TOC entry 217 (class 1259 OID 16403)
-- Name: region_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.region_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.region_id_seq OWNER TO postgres;
--
-- TOC entry 3591 (class 0 OID 0)
-- Dependencies: 217
-- Name: region_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.region_id_seq OWNED BY public.region.id;
--
-- TOC entry 228 (class 1259 OID 16464)
-- Name: scrape; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrape (
    id integer NOT NULL,
    scrape_run_id integer,
    store_id integer NOT NULL,
    region_id integer,
    type text NOT NULL,
    "sourceUrl" text NOT NULL,
    status text,
    "startedAt" timestamp with time zone,
    "finishedAt" timestamp with time zone,
    "workerId" text,
    "proxyId" bigint,
    "configVersion" text,
    "errorMessage" text DEFAULT ''::text,
    "weightRequired" boolean DEFAULT false NOT NULL,
    metadata jsonb
);
ALTER TABLE public.scrape OWNER TO postgres;
--
-- TOC entry 227 (class 1259 OID 16463)
-- Name: scrape_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.scrape_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.scrape_id_seq OWNER TO postgres;
--
-- TOC entry 3592 (class 0 OID 0)
-- Dependencies: 227
-- Name: scrape_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.scrape_id_seq OWNED BY public.scrape.id;
--
-- TOC entry 230 (class 1259 OID 16479)
-- Name: scrape_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrape_log (
    id integer NOT NULL,
    scrape_id integer,
    "logLevel" text,
    message text,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.scrape_log OWNER TO postgres;
--
-- TOC entry 229 (class 1259 OID 16478)
-- Name: scrape_log_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.scrape_log_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.scrape_log_id_seq OWNER TO postgres;
--
-- TOC entry 3593 (class 0 OID 0)
-- Dependencies: 229
-- Name: scrape_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.scrape_log_id_seq OWNED BY public.scrape_log.id;
--
-- TOC entry 226 (class 1259 OID 16452)
-- Name: scrape_run; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.scrape_run (
    id integer NOT NULL,
    "startedAt" timestamp with time zone NOT NULL,
    "finishedAt" timestamp with time zone,
    status text NOT NULL,
    "initiatedBy" text,
    stats jsonb,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.scrape_run OWNER TO postgres;
--
-- TOC entry 225 (class 1259 OID 16451)
-- Name: scrape_run_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.scrape_run_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.scrape_run_id_seq OWNER TO postgres;
--
-- TOC entry 3594 (class 0 OID 0)
-- Dependencies: 225
-- Name: scrape_run_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.scrape_run_id_seq OWNED BY public.scrape_run.id;
--
-- TOC entry 216 (class 1259 OID 16389)
-- Name: store; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.store (
    id integer NOT NULL,
    name text NOT NULL,
    domain text,
    "baseUrl" text,
    "countryCode" character(2),
    channel text DEFAULT 'online'::text NOT NULL,
    config jsonb,
    "configVersion" text,
    active boolean DEFAULT true NOT NULL,
    "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.store OWNER TO postgres;
--
-- TOC entry 215 (class 1259 OID 16388)
-- Name: store_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.store_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.store_id_seq OWNER TO postgres;
--
-- TOC entry 3595 (class 0 OID 0)
-- Dependencies: 215
-- Name: store_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.store_id_seq OWNED BY public.store.id;
--
-- TOC entry 234 (class 1259 OID 16500)
-- Name: worker; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.worker (
    id integer NOT NULL,
    "workerName" text,
    ip text,
    "dateCreated" timestamp with time zone DEFAULT now() NOT NULL,
    "lastHeartbeat" timestamp with time zone,
    "errorCount" integer DEFAULT 0 NOT NULL,
    "dateKilled" timestamp with time zone,
    "isAlive" boolean DEFAULT true NOT NULL
);
ALTER TABLE public.worker OWNER TO postgres;
--
-- TOC entry 233 (class 1259 OID 16499)
-- Name: worker_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.worker_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
ALTER SEQUENCE public.worker_id_seq OWNER TO postgres;
--
-- TOC entry 3596 (class 0 OID 0)
-- Dependencies: 233
-- Name: worker_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.worker_id_seq OWNED BY public.worker.id;
--
-- TOC entry 3329 (class 2604 OID 16418)
-- Name: brand id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.brand
ALTER COLUMN id
SET DEFAULT nextval('public.brand_id_seq'::regclass);
--
-- TOC entry 3331 (class 2604 OID 16430)
-- Name: category id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.category
ALTER COLUMN id
SET DEFAULT nextval('public.category_id_seq'::regclass);
--
-- TOC entry 3357 (class 2604 OID 16704)
-- Name: daily_price_aggregate id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_price_aggregate
ALTER COLUMN id
SET DEFAULT nextval('public.daily_price_aggregate_id_seq'::regclass);
--
-- TOC entry 3348 (class 2604 OID 16517)
-- Name: extraction_model id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.extraction_model
ALTER COLUMN id
SET DEFAULT nextval('public.extraction_model_id_seq'::regclass);
--
-- TOC entry 3358 (class 2604 OID 16684)
-- Name: fx_rate id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fx_rate
ALTER COLUMN id
SET DEFAULT nextval('public.fx_rate_id_seq'::regclass);
--
-- TOC entry 3351 (class 2604 OID 16527)
-- Name: price_observation id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ALTER COLUMN id
SET DEFAULT nextval('public.price_observation_id_seq'::regclass);
--
-- TOC entry 3333 (class 2604 OID 16441)
-- Name: product id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product
ALTER COLUMN id
SET DEFAULT nextval('public.product_id_seq'::regclass);
--
-- TOC entry 3355 (class 2604 OID 16545)
-- Name: product_link id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_link
ALTER COLUMN id
SET DEFAULT nextval('public.product_link_id_seq'::regclass);
--
-- TOC entry 3343 (class 2604 OID 16492)
-- Name: proxy id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.proxy
ALTER COLUMN id
SET DEFAULT nextval('public.proxy_id_seq'::regclass);
--
-- TOC entry 3327 (class 2604 OID 16407)
-- Name: region id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.region
ALTER COLUMN id
SET DEFAULT nextval('public.region_id_seq'::regclass);
--
-- TOC entry 3338 (class 2604 OID 16467)
-- Name: scrape id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape
ALTER COLUMN id
SET DEFAULT nextval('public.scrape_id_seq'::regclass);
--
-- TOC entry 3341 (class 2604 OID 16482)
-- Name: scrape_log id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape_log
ALTER COLUMN id
SET DEFAULT nextval('public.scrape_log_id_seq'::regclass);
--
-- TOC entry 3336 (class 2604 OID 16455)
-- Name: scrape_run id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape_run
ALTER COLUMN id
SET DEFAULT nextval('public.scrape_run_id_seq'::regclass);
--
-- TOC entry 3322 (class 2604 OID 16392)
-- Name: store id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.store
ALTER COLUMN id
SET DEFAULT nextval('public.store_id_seq'::regclass);
--
-- TOC entry 3344 (class 2604 OID 16503)
-- Name: worker id; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.worker
ALTER COLUMN id
SET DEFAULT nextval('public.worker_id_seq'::regclass);
--
-- TOC entry 3389 (class 2606 OID 16487)
-- Name: scrape_log PK_012164e692707dbf8e19fb432a9; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape_log
ADD CONSTRAINT "PK_012164e692707dbf8e19fb432a9" PRIMARY KEY (id);
--
-- TOC entry 3409 (class 2606 OID 16550)
-- Name: product_link PK_107c1bd139920eb477f0ba04b8d; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_link
ADD CONSTRAINT "PK_107c1bd139920eb477f0ba04b8d" PRIMARY KEY (id);
--
-- TOC entry 3383 (class 2606 OID 16473)
-- Name: scrape PK_1428a194a4207c1631898dd0d80; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape
ADD CONSTRAINT "PK_1428a194a4207c1631898dd0d80" PRIMARY KEY (id);
--
-- TOC entry 3417 (class 2606 OID 16691)
-- Name: fx_rate PK_172deb302807396e0da8f0aafe0; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.fx_rate
ADD CONSTRAINT "PK_172deb302807396e0da8f0aafe0" PRIMARY KEY (id);
--
-- TOC entry 3401 (class 2606 OID 16534)
-- Name: price_observation PK_4001253d0205b287f5b183dbf8a; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ADD CONSTRAINT "PK_4001253d0205b287f5b183dbf8a" PRIMARY KEY (id);
--
-- TOC entry 3391 (class 2606 OID 16496)
-- Name: proxy PK_581edf779fc90b8d2687c658276; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.proxy
ADD CONSTRAINT "PK_581edf779fc90b8d2687c658276" PRIMARY KEY (id);
--
-- TOC entry 3364 (class 2606 OID 16412)
-- Name: region PK_5f48ffc3af96bc486f5f3f3a6da; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.region
ADD CONSTRAINT "PK_5f48ffc3af96bc486f5f3f3a6da" PRIMARY KEY (id);
--
-- TOC entry 3411 (class 2606 OID 16714)
-- Name: daily_price_aggregate PK_8e119e7ed57c81c39a9c985ed57; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_price_aggregate
ADD CONSTRAINT "PK_8e119e7ed57c81c39a9c985ed57" PRIMARY KEY (id);
--
-- TOC entry 3379 (class 2606 OID 16460)
-- Name: scrape_run PK_97bb9f148f3599155d656aa8845; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape_run
ADD CONSTRAINT "PK_97bb9f148f3599155d656aa8845" PRIMARY KEY (id);
--
-- TOC entry 3371 (class 2606 OID 16435)
-- Name: category PK_9c4e4a89e3674fc9f382d733f03; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.category
ADD CONSTRAINT "PK_9c4e4a89e3674fc9f382d733f03" PRIMARY KEY (id);
--
-- TOC entry 3367 (class 2606 OID 16423)
-- Name: brand PK_a5d20765ddd942eb5de4eee2d7f; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.brand
ADD CONSTRAINT "PK_a5d20765ddd942eb5de4eee2d7f" PRIMARY KEY (id);
--
-- TOC entry 3374 (class 2606 OID 16447)
-- Name: product PK_bebc9158e480b949565b4dc7a82; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product
ADD CONSTRAINT "PK_bebc9158e480b949565b4dc7a82" PRIMARY KEY (id);
--
-- TOC entry 3399 (class 2606 OID 16522)
-- Name: extraction_model PK_c39927aafde9367cf28e2f27412; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.extraction_model
ADD CONSTRAINT "PK_c39927aafde9367cf28e2f27412" PRIMARY KEY (id);
--
-- TOC entry 3395 (class 2606 OID 16510)
-- Name: worker PK_dc8175fa0e34ce7a39e4ec73b94; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.worker
ADD CONSTRAINT "PK_dc8175fa0e34ce7a39e4ec73b94" PRIMARY KEY (id);
--
-- TOC entry 3414 (class 2606 OID 16566)
-- Name: daily_market_index PK_e4a365d2b3b88473c993450314a; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.daily_market_index
ADD CONSTRAINT "PK_e4a365d2b3b88473c993450314a" PRIMARY KEY (day);
--
-- TOC entry 3360 (class 2606 OID 16400)
-- Name: store PK_f3172007d4de5ae8e7692759d79; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.store
ADD CONSTRAINT "PK_f3172007d4de5ae8e7692759d79" PRIMARY KEY (id);
--
-- TOC entry 3368 (class 1259 OID 16425)
-- Name: idx_brand_canonical; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_brand_canonical ON public.brand USING btree (canonical);
--
-- TOC entry 3369 (class 1259 OID 16424)
-- Name: idx_brand_name_tsv; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_brand_name_tsv ON public.brand USING btree (name);
--
-- TOC entry 3372 (class 1259 OID 16436)
-- Name: idx_category_store_parent; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_category_store_parent ON public.category USING btree (store_id, "parentId");
--
-- TOC entry 3415 (class 1259 OID 16567)
-- Name: idx_dmi_country_day; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dmi_country_day ON public.daily_market_index USING btree ("countryCode", day);
--
-- TOC entry 3412 (class 1259 OID 16715)
-- Name: idx_dpa_day_region_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_dpa_day_region_category ON public.daily_price_aggregate USING btree (day, "regionId", "categoryId");
--
-- TOC entry 3418 (class 1259 OID 16698)
-- Name: idx_fx_day_currency; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_fx_day_currency ON public.fx_rate USING btree (day, "baseCurrency", "quoteCurrency");
--
-- TOC entry 3402 (class 1259 OID 16667)
-- Name: idx_price_obs_availability; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_price_obs_availability ON public.price_observation USING btree (availability);
--
-- TOC entry 3403 (class 1259 OID 16537)
-- Name: idx_price_obs_currency; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_price_obs_currency ON public.price_observation USING btree (currency);
--
-- TOC entry 3404 (class 1259 OID 16535)
-- Name: idx_price_obs_is_promo; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_price_obs_is_promo ON public.price_observation USING btree ("isPromo");
--
-- TOC entry 3405 (class 1259 OID 16540)
-- Name: idx_price_obs_product_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_price_obs_product_date ON public.price_observation USING btree (product_id, "observedAt");
--
-- TOC entry 3406 (class 1259 OID 16538)
-- Name: idx_price_obs_region; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_price_obs_region ON public.price_observation USING btree (region_id);
--
-- TOC entry 3407 (class 1259 OID 16539)
-- Name: idx_price_obs_store_date; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_price_obs_store_date ON public.price_observation USING btree (store_id, "observedAt");
--
-- TOC entry 3375 (class 1259 OID 16449)
-- Name: idx_product_brand; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_product_brand ON public.product USING btree (brand_id);
--
-- TOC entry 3376 (class 1259 OID 16450)
-- Name: idx_product_store; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_product_store ON public.product USING btree (store_id);
--
-- TOC entry 3377 (class 1259 OID 16448)
-- Name: idx_product_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_product_unique ON public.product USING btree (store_id, name, "quantityValue", "quantityUnit");
--
-- TOC entry 3392 (class 1259 OID 16498)
-- Name: idx_proxy_last_used; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_proxy_last_used ON public.proxy USING btree ("last_used");
--
-- TOC entry 3393 (class 1259 OID 16497)
-- Name: idx_proxy_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_proxy_type ON public.proxy USING btree (type);
--
-- TOC entry 3365 (class 1259 OID 16413)
-- Name: idx_region_country; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_region_country ON public.region USING btree ("countryCode");
--
-- TOC entry 3384 (class 1259 OID 16474)
-- Name: idx_scrape_finished; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrape_finished ON public.scrape USING btree ("finishedAt");
--
-- TOC entry 3385 (class 1259 OID 16475)
-- Name: idx_scrape_run_fk; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrape_run_fk ON public.scrape USING btree (scrape_run_id);
--
-- TOC entry 3380 (class 1259 OID 16461)
-- Name: idx_scrape_run_started; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrape_run_started ON public.scrape_run USING btree ("startedAt");
--
-- TOC entry 3381 (class 1259 OID 16462)
-- Name: idx_scrape_run_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrape_run_status ON public.scrape_run USING btree (status);
--
-- TOC entry 3386 (class 1259 OID 16476)
-- Name: idx_scrape_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrape_status ON public.scrape USING btree (status);
--
-- TOC entry 3387 (class 1259 OID 16477)
-- Name: idx_scrape_store_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_scrape_store_type ON public.scrape USING btree (store_id, type);
--
-- TOC entry 3361 (class 1259 OID 16402)
-- Name: idx_store_country; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_store_country ON public.store USING btree ("countryCode");
--
-- TOC entry 3362 (class 1259 OID 16401)
-- Name: idx_store_name; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_store_name ON public.store USING btree (name);
--
-- TOC entry 3396 (class 1259 OID 16512)
-- Name: idx_worker_alive; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_worker_alive ON public.worker USING btree ("isAlive");
--
-- TOC entry 3397 (class 1259 OID 16511)
-- Name: idx_worker_last_heartbeat; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_worker_last_heartbeat ON public.worker USING btree ("lastHeartbeat");
--
-- TOC entry 3420 (class 2606 OID 16580)
-- Name: product FK_0dce9bc93c2d2c399982d04bef1; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product
ADD CONSTRAINT "FK_0dce9bc93c2d2c399982d04bef1" FOREIGN KEY (category_id) REFERENCES public.category(id) ON DELETE CASCADE;
--
-- TOC entry 3421 (class 2606 OID 16590)
-- Name: product FK_2eb5ce4324613b4b457c364f4a2; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product
ADD CONSTRAINT "FK_2eb5ce4324613b4b457c364f4a2" FOREIGN KEY (brand_id) REFERENCES public.brand(id);
--
-- TOC entry 3427 (class 2606 OID 16620)
-- Name: price_observation FK_388d27e195c977469d7e0da7db5; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ADD CONSTRAINT "FK_388d27e195c977469d7e0da7db5" FOREIGN KEY (store_id) REFERENCES public.store(id) ON DELETE CASCADE;
--
-- TOC entry 3422 (class 2606 OID 16585)
-- Name: product FK_4fb20f5e0d195dcc2e27e8cc815; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product
ADD CONSTRAINT "FK_4fb20f5e0d195dcc2e27e8cc815" FOREIGN KEY (store_id) REFERENCES public.store(id) ON DELETE CASCADE;
--
-- TOC entry 3426 (class 2606 OID 16610)
-- Name: scrape_log FK_59b5604f57a81bd9f1c61c02cf1; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape_log
ADD CONSTRAINT "FK_59b5604f57a81bd9f1c61c02cf1" FOREIGN KEY (scrape_id) REFERENCES public.scrape(id) ON DELETE CASCADE;
--
-- TOC entry 3428 (class 2606 OID 16630)
-- Name: price_observation FK_80fdca0879f7071d7b3fb89fd0c; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ADD CONSTRAINT "FK_80fdca0879f7071d7b3fb89fd0c" FOREIGN KEY (scrape_id) REFERENCES public.scrape(id);
--
-- TOC entry 3432 (class 2606 OID 16669)
-- Name: product_link FK_90a4e13a61f23e6d7897e4098c1; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_link
ADD CONSTRAINT "FK_90a4e13a61f23e6d7897e4098c1" FOREIGN KEY (product_id) REFERENCES public.product(id);
--
-- TOC entry 3429 (class 2606 OID 16635)
-- Name: price_observation FK_931c2be032f2a929fefd68f13bd; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ADD CONSTRAINT "FK_931c2be032f2a929fefd68f13bd" FOREIGN KEY (extraction_model_id) REFERENCES public.extraction_model(id);
--
-- TOC entry 3430 (class 2606 OID 16625)
-- Name: price_observation FK_9be978258a66d6630c4b66c70e6; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ADD CONSTRAINT "FK_9be978258a66d6630c4b66c70e6" FOREIGN KEY (region_id) REFERENCES public.region(id);
--
-- TOC entry 3419 (class 2606 OID 16575)
-- Name: category FK_9d0921940cddedc4eb5db92871d; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.category
ADD CONSTRAINT "FK_9d0921940cddedc4eb5db92871d" FOREIGN KEY (store_id) REFERENCES public.store(id) ON DELETE CASCADE;
--
-- TOC entry 3433 (class 2606 OID 16674)
-- Name: product_link FK_9f933e6c34c9c0df84218d15ef5; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.product_link
ADD CONSTRAINT "FK_9f933e6c34c9c0df84218d15ef5" FOREIGN KEY (linked_product_id) REFERENCES public.product(id);
--
-- TOC entry 3431 (class 2606 OID 16615)
-- Name: price_observation FK_c55c1e9deffb01fc81244f1d948; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.price_observation
ADD CONSTRAINT "FK_c55c1e9deffb01fc81244f1d948" FOREIGN KEY (product_id) REFERENCES public.product(id) ON DELETE CASCADE;
--
-- TOC entry 3423 (class 2606 OID 16605)
-- Name: scrape FK_ccc614e2aefa1aac4478040add1; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape
ADD CONSTRAINT "FK_ccc614e2aefa1aac4478040add1" FOREIGN KEY (region_id) REFERENCES public.region(id);
--
-- TOC entry 3424 (class 2606 OID 16595)
-- Name: scrape FK_eb07c8012a70edd561fcca3f69d; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape
ADD CONSTRAINT "FK_eb07c8012a70edd561fcca3f69d" FOREIGN KEY (scrape_run_id) REFERENCES public.scrape_run(id) ON DELETE CASCADE;
--
-- TOC entry 3425 (class 2606 OID 16600)
-- Name: scrape FK_fb5671288e845fc6cc66f8ffdd0; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.scrape
ADD CONSTRAINT "FK_fb5671288e845fc6cc66f8ffdd0" FOREIGN KEY (store_id) REFERENCES public.store(id) ON DELETE CASCADE;
-- Completed on 2025-11-05 23:52:05 UTC
--
-- PostgreSQL database dump complete
--

--- POST FIXES:
ALTER TABLE scrape_log
ADD COLUMN scrape_job_id integer;
ALTER TABLE scrape_log
ADD CONSTRAINT fk_scrape_log_job FOREIGN KEY (scrape_job_id) REFERENCES scrape_job(id) ON DELETE CASCADE;
CREATE TABLE scrape_job (
    id SERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    status VARCHAR NOT NULL DEFAULT 'pending',
    "lastScraped" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ DEFAULT now(),
    "updatedAt" TIMESTAMPTZ DEFAULT now(),
    "store_id" INTEGER REFERENCES store(id)
);
CREATE TABLE public.scrape_content (
    id SERIAL PRIMARY KEY,
    scrape_job_id INT REFERENCES scrape_job(id) ON DELETE CASCADE,
    scraped_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    status_code INT,
    content_type TEXT,
    html TEXT,
    -- full HTML snapshot
    text_content TEXT,
    -- optional stripped text
    content_hash TEXT,
    -- md5/sha256 hash for change detection
    metadata JSONB,
    -- headers, timing, proxy, etc.
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_scrape_content_job ON scrape_content(scrape_job_id);
CREATE INDEX idx_scrape_content_hash ON scrape_content(content_hash);