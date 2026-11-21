# BelleVibe Casino

BelleVibe Casino est une plateforme de casino en ligne entièrement dédiée au blackjack, offrant une expérience immersive avec des croupiers en direct diffusés par vidéo. Les joueurs misent en temps réel pendant que le croupier distribue les cartes en direct, créant une atmosphère de casino authentique. La plateforme intègre également un salon de discussion en direct permettant aux joueurs d'échanger entre eux et avec le croupier, ainsi qu'un historique détaillé des gains et des pertes pour chaque session de jeu.

## Équipe:

Raphaël, Jérôme, Daniel, Kerian, Andy

## Créer le fichier d'environnement

```bash
DB_USER=admin
DB_PASSWORD=bellevibe_casino
DB_NAME=myapp

GITHUB_CLIENT_ID=Ov23liBGIMJCBKO9QRpr
GITHUB_CLIENT_SECRET=a570d5da40f06412149630e3e1b2070b431c81a2
CLE_DETECTION=480de728e44dcc669aaf7457486ad3eb
```

## Lancer l'application

Prérequis : Docker Desktop démarré.

Tout d'abord il faut cloner le répertoire, puis lancer cette commande dans la racine du projet :

```bash
docker compose up -d --build
```

Une fois que les containers sont lancés, l'application est disponible sur http://localhost:5173.

## Comptes de démonstration

| Rôle  | Nom d'utilisateur | Courriel             | Mot de passe |
| ------ | ----------------- | -------------------- | ------------ |
| Player | JoueurTest        | player@bellevibe.com | 12345678!    |
| Dealer | CroupierTest      | dealer@bellevibe.com | 12345678!    |

Ces comptes sont préenregistrés dans la base de données afin de pouvoir faire des tests.

## Tests

À la racine du dépôt pendant que le docker est en train de rouler :

```
docker compose exec backend npm test
```

Cette commande construit le client puis exécute les tests du serveur.

## Blackjack avec caméra

- **Argent fictif** : aucun paiement réel. Le solde se modifie dans la page de gestion du compte (http://localhost:5173/compte); les mises et les gains sont enregistrés dans le compte et l'historique des transactions.
- **Cartes réelles détectées** : le croupier ouvre le salon et filme la table. Le service de reconnaissance transmet les cartes détectées au serveur, qui maintient l'état de la manche et le diffuse en temps réel.
- **Actions du joueur** : tirer, rester et doubler sont envoyés au serveur par HTTP. Tirer et doubler attendent que la carte correspondante soit physiquement distribuée et reconnue par la caméra. Le croupier doit retourner ses cartes devant la caméra pour permettre le règlement.
- **Règles** : le serveur valide les tours, les mises et les gains. Le split n'est pas pris en charge. Après le règlement, miser de nouveau démarre la manche suivante.

### Ce qu'on peut tester

- **Connexion / Créer un compte** : en arrivant sur l'application, une fenêtre propose de se connecter, de créer un compte ou de continuer en tant qu'invité. La connexion avec GitHub est aussi disponible. En mode invité, le bouton de connexion reste accessible dans la barre de navigation.
- **Créer un salon (dealer)** : avec un compte croupier, créer un salon, autoriser l'accès à la caméra et filmer les cartes distribuées. Le croupier peut aussi fermer son salon.
- **Rejoindre un salon et jouer (player)** : avec un compte joueur, rejoindre un siège (6 places au maximum), miser, puis choisir tirer, rester ou doubler à son tour. Les cartes et résultats s'affichent dans l'état de la table.
- **Manche suivante** : après le règlement, miser à nouveau pour participer à la prochaine manche.
- **Temps réel** : les mises, les cartes détectées et les états des tours sont diffusés par Socket.io. En ouvrant deux navigateurs avec des comptes différents, chaque client voit la table se mettre à jour.
- **Mode spectateur** : les invités peuvent regarder un salon sans jouer; les cartes affichées sont celles détectées sur la table physique.

## Liens utiles

- [BackLog](https://github.com/N-VD/Projet-3/blob/main/Doc/02-Backlog.md)
- [Doccuments](https://github.com/N-VD/Projet-3/tree/main/Doc)
- [Journal](https://github.com/N-VD/Projet-3/blob/main/Doc/Journal.md)
- [Consignes / Site web du cours](https://archambaultv.github.io/2026A-420-5D1-MA-Gr2/)
