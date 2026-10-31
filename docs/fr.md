# GreenEye Monitor pour Gladys Assistant

Cette intégration affiche dans Gladys les valeurs d’un **GreenEye Monitor**
de Brultech (GEM), le moniteur d’énergie 32 canaux fabriqué en
Colombie-Britannique : énergie et puissance de chaque canal, courant,
tension, compteurs d’impulsions (eau, gaz) et températures. Tout reste sur
votre réseau local, sans cloud.

Intégration non officielle, sans lien avec Brultech. **Jamais testé avec un
vrai GEM** : elle suit le document du format de paquets GEM de Brultech et les
bibliothèques siobrultech-protocols et greeneye-monitor (MIT) de Home
Assistant, et est testée sur leurs captures de paquets. Vos retours avec un
vrai moniteur sont les bienvenus.

**Lecture seule** : rien n’est jamais envoyé au GEM. L’intégration ne change
aucun réglage du moniteur.

## Ce que vous obtenez

- un appareil **GreenEye <numéro>** (le moniteur) : tension (V), les compteurs
  d’impulsions qui ont compté (nombre brut d’impulsions), les températures
  (°C) une fois leur unité choisie ;
- un appareil par canal, **GreenEye <numéro> canal <n>** : index d’énergie
  (kWh, pour le suivi énergétique de Gladys), puissance (W) et courant (A) ;
  sur un canal NET qui produit (solaire), un index de l’énergie produite
  (kWh), et une puissance négative pendant la production.

Un canal apparaît dans l’onglet **Découverte** dès qu’il a mesuré de
l’énergie (son compteur a monté entre deux paquets). Les canaux inutilisés
d’un paquet 48 canaux portent des valeurs parasites figées : ils n’apparaissent
jamais d’eux-mêmes. Pour choisir les canaux vous-même, saisissez-les dans
**Canaux à afficher** (comme `1-12, 15`).

Le numéro de série du GEM est dans chaque identifiant externe : un second GEM
ne reprend jamais l’historique du premier.

## Réglages du GEM

Dans la page web du GEM, dans les réglages d’envoi des paquets (« Packet
Send », mode client TCP) :

- **serveur** : l’adresse IP de la machine Gladys sur votre réseau ;
- **port** : le port affiché dans la section « Comment le GEM joint Gladys »
  de l’écran de configuration (choisi par Gladys, voir plus bas) ;
- **format de paquet** : un format binaire, BIN48-NET, BIN32-NET,
  BIN48-NET-TIME, BIN48-ABS ou BIN32-ABS. Prenez un format NET si un canal
  mesure une production solaire : avec un format ABS, le GEM compte ensemble
  l’énergie des deux sens, et l’index d’un tel canal ajoute la production à la
  consommation. Sur un canal NET, le GEM compte la production dans son
  compteur « polarisé » : la pince doit être orientée comme le GEM l’attend
  (le sens réglé sur le GEM), sinon consommation et production s’inversent
  (l’état le dit quand un index de consommation est à 0 ou moins). Les formats ASCII et les moniteurs ECM-1220/1240 ne sont pas
  pris en charge (l’état compte les paquets ECM ignorés) ;
- **intervalle** : au choix (1 à 255 s). La puissance est la moyenne sur les
  deux derniers paquets.

### Températures : choisissez l’unité du GEM

Les paquets portent les températures dans l’unité réglée sur le GEM (°C ou
°F) sans dire laquelle. Choisissez-la dans **Unité de température réglée sur
le GEM** : les valeurs en °F sont converties exactement en °C ((°F − 32) ×
5/9, arrondi à 0,01), et les bornes (−55 à 125 °C, la plage des sondes) sont
vérifiées après conversion. Désactivé (par défaut) : aucune température n’est
publiée. Une sonde qui lit exactement 0 ou « pas de sonde » (au-dessus de 255)
n’est pas une valeur : jamais publiée.

## Comment le GEM joint Gladys

C’est le GEM qui ouvre la connexion (TCP) ; Gladys ne l’interroge pas.
L’intégration démarre donc un petit récepteur à côté d’elle (le conteneur
`gem-link`), dont Gladys publie le port sur la machine.

1. Donnez au GEM une adresse IP fixe dans votre box.
2. Dans l’écran **Configuration** de l’intégration, saisissez cette adresse et
   enregistrez. **Rien n’écoute avant** : le récepteur ne démarre qu’une fois
   une adresse valide enregistrée, et s’arrête si vous l’effacez.
3. Rechargez l’écran : la section « Comment le GEM joint Gladys » affiche le
   port choisi par Gladys (un port libre, gardé ensuite).
4. Réglez le GEM comme ci-dessus. L’état passe à « GEM … connecté » au premier
   paquet.

Le cœur de Gladys tourne sur le réseau hôte de la machine
(`network_mode: host`), mais les intégrations tournent dans des conteneurs
isolés : elles ne peuvent pas écouter elles-mêmes sur la machine. Le
récepteur `gem-link` est un sous-conteneur déclaré dans le manifeste, dont
Gladys publie le port TCP 8000 sur toutes les adresses de la machine. C’est le
même mécanisme que l’intégration Wolf ISM8, vérifié dans un Gladys de test :
une connexion venant du réseau garde sa vraie adresse source ; une connexion
partie de la machine Gladys elle-même arrive avec l’adresse de la passerelle
Docker. Donc :

- autorisez ce port TCP dans le pare-feu de la machine, s’il y en a un ;
- **Vérifier l’expéditeur** (activé par défaut) n’accepte que l’adresse du
  GEM ; une autre adresse est refusée avant la lecture du moindre octet et
  affichée dans l’état. Avec Docker Desktop (Mac, Windows) ou Docker rootless,
  Docker peut remplacer l’adresse source : désactivez l’option dans ce seul
  cas. Toute machine de votre réseau peut alors prendre la place du GEM : il
  lui suffit de recopier son numéro de série (il est dans chaque paquet) pour
  envoyer de fausses valeurs, et ces valeurs entrent dans les index d’énergie
  (jusqu’à 100 kWh par heure et par canal sans être retenues). Même avec la
  vérification, une machine qui prend l’adresse IP du GEM (GEM éteint,
  usurpation ARP) passe : gardez le GEM sur un réseau de confiance ;
- le récepteur n’est redémarré que s’il s’est arrêté ou si l’adresse ou la
  vérification de l’expéditeur change ; quand l’intégration redémarre, Gladys
  redémarre aussi le récepteur et le GEM se reconnecte de lui-même. Quand le
  récepteur tourne mais ne répond pas à l’intégration pendant 3 minutes (un
  autre secret, par exemple après un `/data` illisible et un nouveau secret),
  il est redémarré, au plus toutes les 10 minutes.

## Quel GEM est suivi

Le numéro de série (le numéro à 8 positions affiché par le GEM) est lu dans chaque
paquet. Le premier GEM entendu est suivi et gardé dans `/data` ; les paquets
d’un autre numéro de série sont refusés et l’état le dit. Après un
remplacement du moniteur, saisissez le nouveau numéro dans **Numéro de série
du GEM** : il a ses propres appareils. Ce qui a été vu et retenu pour chaque
numéro reste dans `/data` sous ce numéro (8 au plus) : un numéro mal saisi
puis corrigé garde toutes les retenues. Vider le champ fait de nouveau suivre
le premier GEM entendu. Quand `/data` est illisible, aucun numéro n’est
épinglé : seul un numéro saisi est suivi (l’état donne celui entendu).

## Compteurs à vie : jamais 0, ni baisse ni saut sans vous

L’index d’énergie d’un canal, son index de production et les compteurs
d’impulsions sont les valeurs que le suivi énergétique de Gladys transforme en
consommation : il compte chaque hausse en entier. Donc :

- une valeur 0 n’est pas publiée ;
- une valeur est comparée à la dernière acceptée : pas plus basse, et pas plus
  de 100 kWh par heure en moyenne pour un canal (100 impulsions par seconde
  pour un compteur d’impulsions), plus une petite marge ;
- les compteurs d’énergie du GEM repartent à zéro à 2^40 wattsecondes
  (305 420 kWh) et les compteurs d’impulsions à 2^24 impulsions : ce
  débordement (un compteur proche de son maximum qui repart près de 0, le pas
  à travers le maximum tenant dans la marge ci-dessus) est compté à la suite,
  le décalage gardé dans `/data` (un débordement survenu alors que `/data` n’a
  pas pu garder la valeur précédente apparaît comme une baisse, retenue) ;
- une **baisse** (remise à zéro du GEM, pince remplacée) ou un **saut** est **retenu** : la dernière valeur acceptée est
  renvoyée, rien n’est compté, l’état liste le compteur avec la valeur
  retenue, et la retenue est gardée dans `/data` d’un redémarrage à l’autre.
  Le temps ne la lève pas, la répétition de la même valeur non plus ;
- si c’est réel, cliquez deux fois sur **Accepter les compteurs retenus**
  dans l’écran de configuration : le premier clic liste exactement ce qui sera
  pris et n’accepte rien ; le second, après quelques secondes et dans les 5
  minutes, prend exactement ces valeurs (un saut est alors compté d’un coup
  comme consommation ; une baisse ne compte rien et le compteur repart de
  là). Si les compteurs retenus ont changé entre-temps, rien n’est accepté.
  Enregistrer la configuration n’accepte rien.

Les contrôles tournent sur l’horloge de l’intégration (l’heure murale lue une
fois à son démarrage plus le temps écoulé depuis) : une heure murale déplacée
par NTP ne les élargit ni ne les resserre.

## Fraîcheur et état

- Les valeurs sont publiées à l’arrivée d’un paquet. Les paquets gardés par le
  récepteur pendant l’absence de l’intégration sont abandonnés s’ils ont plus
  d’une minute ; un paquet répété, ou plus ancien dans la même connexion
  (d’après le compteur de secondes du GEM), est abandonné. Un recul du
  compteur de secondes dans une nouvelle connexion est un redémarrage du
  GEM : ses paquets sont pris et l’état le dit pendant 10 minutes.
- Une écriture dans `/data` qui ne se termine pas en 5 secondes (disque figé)
  est dite dans l’état ; les écritures suivantes attendent derrière, une au
  plus.
- Aucun paquet depuis 2 minutes (ou trois intervalles du GEM, jusqu’à 15
  minutes) : l’état dit depuis combien de temps, l’intégration n’est pas
  « connectée », et rien n’est inventé.
- Gladys accepte 300 valeurs par minute : avec beaucoup de canaux et un
  intervalle court, les valeurs partent à tour de rôle (la plus récente de
  chacune), 250 par minute au plus.

## Limites

- Un GEM par intégration.
- L’API de réglages du GEM (types de pinces, intervalles) n’est pas utilisée.
- Non pris en charge : formats de paquets ASCII, moniteurs ECM-1220/1240,
  compteurs d’impulsions convertis en volumes (ce sont des nombres bruts).
