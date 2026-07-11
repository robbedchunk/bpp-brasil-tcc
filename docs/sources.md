# Sources and provenance

## IPCA/POF food-at-home weights

The numeric source of truth is IBGE's final December 2019 POF 2017–2018 archive,
workbook `Estrutura_IPCA.xlsx`, sheet `SP`. The committed reduced artifact is
`data/reference/ipca_pof2017_2018_sp_food_at_home_weights.csv` with 84 unique
seven-digit food-at-home sub-items and exact São Paulo total weight `12.1181`%
of all-items IPCA. Its provenance README records archive/workbook/CSV SHA-256,
source row, area, subgroup, category, and citation fields.

BCB Estudos Especiais nº 69/2019, *Atualizações da estrutura de ponderação do
IPCA e repercussão nas suas classificações*, is methodological context and a
cross-check; it is not the numeric source copied into the CSV:

https://www.bcb.gov.br/conteudo/relatorioinflacao/EstudosEspeciais/EE069_Atualizacoes_da_estrutura_de_ponderacao_do_IPCA_e_repercussao_nas_suas_classificacoes.pdf

## Official comparison

The fixed official comparison is IBGE SIDRA aggregate/table 7060:

- variable `63`: IPCA monthly percentage change;
- territorial level `N7`, area `3501`: São Paulo (SP);
- classification `315`, category `7171`: `11.Alimentação no domicílio`.

Data endpoint:

https://servicodados.ibge.gov.br/api/v3/agregados/7060/periodos/all/variaveis/63?localidades=N7%5B3501%5D&classificacao=315%5B7171%5D

Metadata endpoint:

https://servicodados.ibge.gov.br/api/v3/agregados/7060/metadados

API semantics: https://apisidra.ibge.gov.br/home/ajuda

The official N7 area and retailer CEP panel are not identical geographic units.
Official values remain monthly and only closed overlapping months are compared.

## Literature

Cavallo, A.; Rigobon, R. (2016). “The Billion Prices Project: Using Online Prices
for Measurement and Research.” *Journal of Economic Perspectives*, 30(2),
151–178. DOI: https://doi.org/10.1257/jep.30.2.151

## Retailer/platform reference

The VTEX public catalog candidate pattern is
`/api/catalog_system/pub/products/search`. Availability is verified per
storefront and CEP/store identity; the project never assumes every VTEX tenant
or seller mapping is public or regionally valid.
