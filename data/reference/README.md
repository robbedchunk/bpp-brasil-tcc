# IPCA reference data

`ipca_pof2017_2018_sp_food_at_home_weights.csv` is the fixed São Paulo
food-at-home reference used by the project. It contains the 84 seven-digit
SNIPC subitems under subgroup `1100000` (`11.Alimentação no domicílio`) and
expresses every weight as a percentage of the **total São Paulo IPCA**.

## Provenance

The numeric source is the IBGE final December 2019 POF 2017-2018 structure
archive:

- Archive: [Estruturas_para_divulgacao_dez19.zip](https://ftp.ibge.gov.br/Precos_Indices_de_Precos_ao_Consumidor/IPCA/Atualizacao_das_Estruturas_POF2017-2018/Estruturas_para_divulgacao_dez19.zip)
- Workbook: `Estrutura_IPCA.xlsx`
- Worksheet: `SP`
- Worksheet title: `Estrutura de ponderação - IPCA - São Paulo - dez. 2019`
- Archive SHA-256: `0ba845113682c96015a0e93daf4b10bc93aad82c2c1d6ea406282af958bf9104`
- Workbook SHA-256: `2f6b759b3dfc4c38ebc791afc5c7e5e7a0b77b90c40f646246f4878a3dc4be4a`

The archive and the workbook were both tested as valid ZIP containers before
extraction. The recorded `source_row` is the one-based Excel row on worksheet
`SP`; the selected rows run from 8 through 106 with hierarchy/item rows omitted.
The workbook's displayed four-decimal subitem weights are preserved verbatim.

SIDRA table 7060 supplies the stable category identifier crosswalk, not the
numeric source for this file. The crosswalk query is variable `66` (`IPCA - Peso
mensal`), period `202001`, territorial member `N7[3501]`, and all members of
classification `315`:

- [IBGE SIDRA table 7060](https://sidra.ibge.gov.br/tabela/7060)
- [Exact IBGE aggregate API crosswalk](https://servicodados.ibge.gov.br/api/v3/agregados/7060/periodos/202001/variaveis/66?localidades=N7%5B3501%5D&classificacao=315%5Ball%5D)

The geographic metadata in the CSV follows that response: level `N7`, code
`3501`, and name `São Paulo (SP)`. The BCB's [Estudo Especial 69/2019](https://www.bcb.gov.br/conteudo/relatorioinflacao/EstudosEspeciais/EE069_Atualizacoes_da_estrutura_de_ponderacao_do_IPCA_e_repercussao_nas_suas_classificacoes.pdf)
is the methodological cross-check: it documents the POF 2017-2018 replacement
of the prior structure and its January 2020 effective date.

## Extraction and joins

Selection starts after workbook row `1100000` and keeps only seven-digit SNIPC
subitem codes below `1200000`; hierarchy rows whose codes end in `000` are
excluded. The result has 84 rows and 84 unique SNIPC codes.

Workbook and SIDRA records are joined on the seven-digit SNIPC code parsed from
the start of the SIDRA category name. `sidra_category_id` stores SIDRA's member
ID (`categoria` key), while `subitem_name` deliberately preserves the workbook
spelling. Descriptions are not join keys: the following nine matched codes
differ only in hyphen spacing between the two official sources.

| SNIPC code | Workbook | SIDRA |
| --- | --- | --- |
| `1101073` | `Feijão-carioca (rajado)` | `Feijão - carioca (rajado)` |
| `1106005` | `Banana-d'água` | `Banana - d'água` |
| `1106008` | `Banana-prata` | `Banana - prata` |
| `1106039` | `Laranja-pera` | `Laranja - pera` |
| `1108029` | `Peixe-cação` | `Peixe - cação` |
| `1108031` | `Peixe-merluza` | `Peixe - merluza` |
| `1108038` | `Peixe-pescada` | `Peixe - pescada` |
| `1108075` | `Peixe-salmão` | `Peixe - salmão` |
| `1108080` | `Peixe-tilápia` | `Peixe - tilápia` |

The 84 row-level SIDRA weights for January 2020 also match the workbook values
at four decimals. The authoritative denominator for this file is nevertheless
the selected December 2019 workbook rows; a separately published SIDRA
hierarchy aggregate must not replace it.

## Validation result

- Data rows: `84`
- Distinct `snipc_subitem_code` values: `84`
- Distinct `sidra_category_id` values: `84`
- Negative or non-finite weights: `0`
- Missing source citations or hashes: `0`
- Sum of `weight_pct_total_ipca`: **`12.1181`**
- Required tolerance: `12.1181 ± 0.0001`

The source files were reproduced and checked with:

```bash
curl --fail --location --retry 3 \
  --output /tmp/Estruturas_para_divulgacao_dez19.zip \
  'https://ftp.ibge.gov.br/Precos_Indices_de_Precos_ao_Consumidor/IPCA/Atualizacao_das_Estruturas_POF2017-2018/Estruturas_para_divulgacao_dez19.zip'
sha256sum /tmp/Estruturas_para_divulgacao_dez19.zip
unzip -t /tmp/Estruturas_para_divulgacao_dez19.zip
unzip -o /tmp/Estruturas_para_divulgacao_dez19.zip \
  Estrutura_IPCA.xlsx -d /tmp
sha256sum /tmp/Estrutura_IPCA.xlsx
unzip -t /tmp/Estrutura_IPCA.xlsx
```

## Column and aggregation semantics

- `pof_vintage`, `weight_reference_month`, and `effective_from` identify POF
  `2017-2018`, the `2019-12` reference structure, and its `2020-01-01` effective
  date.
- `sidra_area_level`, `sidra_area_code`, and `area_name` identify the São Paulo
  SNIPC coverage area.
- `snipc_subgroup_code` is always `1100000`; `sidra_category_id` is the
  row-specific SIDRA classification member; `snipc_subitem_code` is the stable
  seven-digit join key.
- `weight_pct_total_ipca` is a percentage of total São Paulo IPCA, not a fraction
  of the food-at-home subgroup and not a decimal proportion.
- `source_sheet` and `source_row` locate the numeric cell; `source_url` and
  `source_archive_sha256` make every row independently traceable.

Index aggregation may cover only a subset of these reference rows. It must
renormalize **only the covered rows** using
`covered_weight_pct_total_ipca = sum(weight_pct_total_ipca for covered rows)`.
Every coverage export must record that denominator and the coverage fraction
`covered_weight_pct_total_ipca / 12.1181`. The source weights themselves remain
unchanged; uncovered rows are not silently assigned to covered items.
